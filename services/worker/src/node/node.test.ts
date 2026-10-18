import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeLlm } from "@verdict/llm";
import {
  createEd25519Signer,
  type Envelope,
  hashObj,
  type OfferedContract,
  sha256Hex,
  signPayload,
} from "@verdict/protocol";
import { FakeHub, FakeWallet } from "@verdict/wallet";
import { describe, expect, it } from "vitest";
import { extractCode, type Generator, llmGenerator } from "../agent/generate.js";
import { WorkerNode } from "./node.js";

const seed = (n: number) => new Uint8Array(32).fill(n);
const ASSET = "rgb:test-asset";
const NOW = new Date("2026-10-18T14:45:00Z");

async function setup(
  over: {
    deadline?: string;
    maxLock?: number;
    verifier?: boolean;
    confirmWaitMs?: number;
    packageSha?: string;
    /** Switch position when the escrow locks (the node reads it once, at task start). */
    disappears?: boolean;
    /** Replaces the fake generator; the directory asked for is still recorded. */
    generator?: Generator;
  } = {},
) {
  const [engine, worker, ver] = await Promise.all(
    [1, 2, 5].map((n) => createEd25519Signer(seed(n))),
  );
  const flags = { disappears: over.disappears ?? false };
  const hub = new FakeHub();
  const buyerWallet = new FakeWallet(`02${"b1".repeat(32)}`, hub);
  const workerWallet = new FakeWallet(`02${"c2".repeat(32)}`, hub);
  const dirsUsed: string[] = [];
  const posted: { type: string; body: unknown; url: string }[] = [];
  const fetchImpl = (async (u: string, init?: RequestInit) => {
    posted.push({ ...(JSON.parse(String(init?.body)) as { type: string; body: unknown }), url: u });
    return Response.json({ ok: true });
  }) as unknown as typeof fetch;
  const node = new WorkerNode({
    signer: worker!,
    engineId: engine!.publicId,
    engineUrl: "http://engine.test",
    wallet: workerWallet,
    assetId: ASSET,
    precision: 2,
    generatorFor: (dir) => {
      dirsUsed.push(dir);
      if (over.generator) return over.generator;
      return async () => ({
        files: [{ path: "csv2json.mjs", content: "console.log('[]');\n" }],
        model: "fake",
        generationMs: 5,
        generatedTokens: 3,
        tokensPerSec: 600,
      });
    },
    resolvePackageDir: async (sha) =>
      sha === (over.packageSha ?? "7".repeat(64)) ? "/pkg/a" : null,
    deliveryRoot: mkdtempSync(join(tmpdir(), "worker-test-")),
    now: () => NOW,
    fetchImpl,
    ...(over.verifier
      ? {
          verifierId: ver!.publicId,
          disappears: () => flags.disappears,
          confirmWaitMs: over.confirmWaitMs ?? 2000,
        }
      : {}),
  });
  node.start();
  const preimage = "ab".repeat(32);
  const body = {
    version: "verdict-task/0" as const,
    buyer: engine!.publicId,
    worker: worker!.publicId,
    capability_hash: "c".repeat(64),
    intent_sha256: "d".repeat(64),
    payment: {
      asset_id: ASSET,
      amount: "1.20",
      payment_hash: sha256Hex(Buffer.from(preimage, "hex")),
      payee_node_id: await workerWallet.nodeId(),
      expiry_blocks: 42,
      expiry_seconds: 3600,
    },
    task: {
      category: "code" as const,
      spec: "Build a CSV-to-JSON CLI",
      deadline: over.deadline ?? "2026-10-18T16:00:00Z",
      max_verify_seconds: 60,
    },
    verifier: {
      public_id: ver!.publicId,
      endpoint: "http://127.0.0.1:7404",
      package_sha256: "7".repeat(64),
      entrypoint: "./verify.sh",
      rule: "EXIT_0_AND_SCHEMA_VALID" as const,
    },
    max_lock_seconds: over.maxLock ?? 28_800,
    safety_margin_seconds: 600,
  };
  const offer: OfferedContract = {
    ...body,
    signatures: { buyer: await signPayload(engine!, "TASK_CONTRACT", body) },
  };
  const envelope = async (o: OfferedContract, from = engine!): Promise<Envelope> => {
    const e = {
      v: 0 as const,
      id: crypto.randomUUID(),
      task_id: `task_${hashObj(o).slice(0, 16)}`,
      from: from.publicId,
      to: worker!.publicId,
      sent_at: "2026-10-18T14:45:00Z",
      type: "TASK_OFFER" as const,
      body: o,
    };
    return { ...e, sig: await signPayload(from, "TASK_OFFER", e) } as Envelope;
  };
  return {
    node,
    offer,
    envelope,
    engine: engine!,
    ver: ver!,
    flags,
    buyerWallet,
    workerWallet,
    posted,
    dirsUsed,
    preimage,
    body,
  };
}
const settle = () => new Promise((r) => setTimeout(r, 50));

describe("WorkerNode", () => {
  it("accepts, invoices for H, and delivers only after the buyer's HTLC is held; never sees P", async () => {
    const t = await setup();
    const r = await t.node.handleOffer(await t.envelope(t.offer));
    expect(r.ok).toBe(true);
    await settle();
    expect(t.posted.map((p) => p.type)).toEqual(["TASK_ACCEPT", "HODL_INVOICE"]);
    const accept = t.posted[0]?.body as { signatures: { buyer: string; worker: string } };
    expect(accept.signatures.worker).toMatch(/./);
    const inv = t.posted[1]?.body as { bolt11: string; payment_hash: string };
    expect(inv.payment_hash).toBe(t.offer.payment.payment_hash);
    const task = t.node.list()[0];
    expect(task?.state).toBe("INVOICE_SENT");
    expect(task?.delivery).toBeUndefined();

    await t.buyerWallet.pay(inv.bolt11); // HTLC held -> Claimable at the worker
    await settle();
    const done = t.node.list()[0];
    expect(done?.state).toBe("DELIVERED");
    expect(done?.delivery?.dirHash).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(join(done?.delivery?.dir ?? "", "csv2json.mjs"), "utf8")).toContain("[]");
    expect(JSON.stringify(t.node.list())).not.toContain(t.preimage);
    expect(JSON.stringify(t.posted)).not.toContain(t.preimage);
  });

  it("refuses a bad signature, a wrong worker, a passed deadline and an unholdable lock window", async () => {
    const t = await setup();
    const other = await createEd25519Signer(seed(9));
    expect((await t.node.handleOffer(await t.envelope(t.offer, other))).ok).toBe(false);
    const tampered = { ...t.offer, payment: { ...t.offer.payment, amount: "9.99" } };
    expect((await t.node.handleOffer(await t.envelope(tampered))).ok).toBe(false);
    const t2 = await setup({ deadline: "2026-10-18T14:00:00Z" });
    expect((await t2.node.handleOffer(await t2.envelope(t2.offer))).ok).toBe(false);
    const t3 = await setup({ maxLock: 20_000 });
    const r3 = await t3.node.handleOffer(await t3.envelope(t3.offer));
    expect(r3).toMatchObject({ ok: false });
    expect(t.posted).toEqual([]);
    expect(t3.posted).toEqual([]);
  });

  it("refuses an offer whose verification package differs from the worker's own copy", async () => {
    const t = await setup({ packageSha: "8".repeat(64) });
    const r = await t.node.handleOffer(await t.envelope(t.offer));
    expect(r).toMatchObject({ ok: false });
    expect(JSON.stringify(r)).toContain("test package not available on this worker");
    const same = await setup({ packageSha: "7".repeat(64) });
    expect((await same.node.handleOffer(await same.envelope(same.offer))).ok).toBe(true);
  });
});

describe("WorkerNode with a verifier", () => {
  const fromVerifier = async (
    t: Awaited<ReturnType<typeof setup>>,
    type: "P_CONFIRM" | "VERDICT" | "PREIMAGE",
    body: unknown,
    tid: string,
  ): Promise<Envelope> => {
    const e = {
      v: 0 as const,
      id: crypto.randomUUID(),
      task_id: tid,
      from: t.ver.publicId,
      to: t.node.list()[0] ? (t.offer.worker as string) : "",
      sent_at: "2026-10-18T14:45:00Z",
      type,
      body,
    };
    return { ...e, sig: await signPayload(t.ver, type, e) } as unknown as Envelope;
  };
  const verdict = async (t: Awaited<ReturnType<typeof setup>>, v: "RELEASE" | "WITHHOLD") => {
    const unsigned = {
      task_id: t.node.list()[0]?.taskId as string,
      contract_sha256: "1".repeat(64),
      delivery_sha256: "2".repeat(64),
      verifier_package_sha256: "7".repeat(64),
      attempt: 1,
      checks: [{ id: "tests", status: v === "RELEASE" ? ("PASS" as const) : ("FAIL" as const) }],
      exit_code: v === "RELEASE" ? 0 : 1,
      verdict: v,
      payment_hash: t.offer.payment.payment_hash,
      timestamp: 1760790000,
    };
    return { ...unsigned, verifier_sig: await signPayload(t.ver, "VERDICT", unsigned) };
  };
  /** Offer -> accept -> P_CONFIRM -> invoice -> buyer pays -> deliver. */
  async function delivered(over: Parameters<typeof setup>[0] = {}) {
    const t = await setup({ verifier: true, ...over });
    await t.node.handleOffer(await t.envelope(t.offer));
    await settle();
    expect(t.posted.map((p) => p.type)).toEqual(["TASK_ACCEPT"]); // no invoice before P_CONFIRM
    const task = t.node.list()[0] as { taskId: string };
    const ok = await t.node.handleMessage(
      await fromVerifier(
        t,
        "P_CONFIRM",
        {
          task_id: task.taskId,
          payment_hash: t.offer.payment.payment_hash,
          package_sha256: "7".repeat(64),
          confirmed: true,
        },
        task.taskId,
      ),
    );
    expect(ok.ok).toBe(true);
    await settle();
    const inv = t.posted.find((p) => p.type === "HODL_INVOICE")?.body as { bolt11: string };
    await t.buyerWallet.pay(inv.bolt11);
    await settle();
    return { t, tid: task.taskId };
  }
  const preimageEnv = (t: Awaited<ReturnType<typeof setup>>, tid: string) =>
    fromVerifier(
      t,
      "PREIMAGE",
      {
        payment_hash: t.offer.payment.payment_hash,
        preimage_hex: t.preimage,
        reason: "VERDICT_RELEASE",
      },
      tid,
    );

  it("resolves the package directory of the contract's hash for the generator", async () => {
    const { t } = await delivered();
    expect(t.dirsUsed).toEqual(["/pkg/a"]);
  });

  it("a NOT_APPLICABLE reply delivers nothing and the task fails", async () => {
    const llm = new FakeLlm(["NOT_APPLICABLE"]);
    const { t } = await delivered({
      generator: llmGenerator(llm, 100, null, { id: "csv2json-v1", description: "CSV to JSON" }),
    });
    const task = t.node.list()[0];
    expect(task?.state).toBe("FAILED");
    expect(t.posted.map((p) => p.type)).not.toContain("DELIVER");
    expect(llm.calls).toHaveLength(1);
  });

  it("waits for P_CONFIRM, delivers a signed DELIVER bundle to the contract's verifier, then claims with P after RELEASE", async () => {
    const { t, tid } = await delivered();
    const d = t.posted.find((p) => p.type === "DELIVER");
    expect(d?.url).toBe("http://127.0.0.1:7404/v0/messages");
    expect(d?.body).toMatchObject({ attempt: 1, self_check_exit_code: -1 });
    expect((d?.body as { bundle_b64: string } | undefined)?.bundle_b64.length).toBeGreaterThan(20);
    expect(t.node.list()[0]?.state).toBe("DELIVERED");
    await t.node.handleMessage(await fromVerifier(t, "VERDICT", await verdict(t, "RELEASE"), tid));
    expect(t.node.list()[0]?.state).toBe("RELEASED");
    const r = await t.node.handleMessage(await preimageEnv(t, tid));
    expect(r.ok).toBe(true);
    expect(t.node.list()[0]?.state).toBe("CLAIMED");
    expect(
      (await t.buyerWallet.paymentStatus(t.offer.payment.payment_hash)).some(
        (e) => e.status === "Settled",
      ),
    ).toBe(true);
  });

  it("ignores a replayed WITHHOLD after RELEASE: state stays and the invoice is not cancelled", async () => {
    const { t, tid } = await delivered();
    const rel = await fromVerifier(t, "VERDICT", await verdict(t, "RELEASE"), tid);
    const wh = await fromVerifier(t, "VERDICT", await verdict(t, "WITHHOLD"), tid);
    expect((await t.node.handleMessage(rel)).ok).toBe(true);
    expect((await t.node.handleMessage(wh)).ok).toBe(false);
    expect((await t.node.handleMessage(rel)).ok).toBe(false);
    await settle();
    expect(t.node.list()[0]?.state).toBe("RELEASED");
    const r = await t.node.handleMessage(await preimageEnv(t, tid));
    expect(r.ok).toBe(true);
    expect(t.node.list()[0]?.state).toBe("CLAIMED");
  });

  it("a WITHHOLD verdict makes the honest worker cancel the held invoice", async () => {
    const { t, tid } = await delivered();
    await t.node.handleMessage(await fromVerifier(t, "VERDICT", await verdict(t, "WITHHOLD"), tid));
    await settle();
    expect(t.node.list()[0]?.state).toBe("CANCELLED");
    expect(
      (await t.buyerWallet.paymentStatus(t.offer.payment.payment_hash)).some(
        (e) => e.status === "Failed",
      ),
    ).toBe(true);
  });

  it("with the disappear switch on, the worker stops right after the lock: no work, no delivery, no claim, no cancel", async () => {
    const a = await delivered({ disappears: true });
    await settle();
    const task = a.t.node.list()[0];
    expect(task?.state).toBe("ABANDONED");
    expect(task?.delivery).toBeUndefined();
    expect(a.t.posted.map((p) => p.type)).not.toContain("DELIVER");
    const seen = await a.t.buyerWallet.paymentStatus(a.t.offer.payment.payment_hash);
    expect(seen.some((e) => e.status === "Failed" || e.status === "Settled")).toBe(false);
  });

  it("the switch is read when the task starts: turning it on mid-task changes nothing, the next task obeys it", async () => {
    const a = await delivered();
    a.t.flags.disappears = true; // flipped after the escrow locked
    await a.t.node.handleMessage(
      await fromVerifier(a.t, "VERDICT", await verdict(a.t, "WITHHOLD"), a.tid),
    );
    await settle();
    const task = a.t.node.list()[0];
    expect(task?.state).toBe("CANCELLED");
    expect(task?.toggles).toEqual({ sabotaged: false, disappears: false });
    const next = await delivered({ disappears: true });
    expect(next.t.node.list()[0]?.toggles).toEqual({ sabotaged: false, disappears: true });
  });

  it("refuses a wrong secret, a stranger's PREIMAGE and a forged verdict", async () => {
    const { t, tid } = await delivered();
    const wrong = await fromVerifier(
      t,
      "PREIMAGE",
      {
        payment_hash: t.offer.payment.payment_hash,
        preimage_hex: "cd".repeat(32),
        reason: "VERDICT_RELEASE",
      },
      tid,
    );
    expect((await t.node.handleMessage(wrong)).ok).toBe(false);
    const stranger = await createEd25519Signer(seed(9));
    const e = {
      v: 0 as const,
      id: crypto.randomUUID(),
      task_id: tid,
      from: stranger.publicId,
      to: t.offer.worker,
      sent_at: "2026-10-18T14:45:00Z",
      type: "PREIMAGE" as const,
      body: {
        payment_hash: t.offer.payment.payment_hash,
        preimage_hex: t.preimage,
        reason: "VERDICT_RELEASE" as const,
      },
    };
    const forged = { ...e, sig: await signPayload(stranger, "PREIMAGE", e) } as Envelope;
    expect((await t.node.handleMessage(forged)).ok).toBe(false);
    const v = await verdict(t, "RELEASE");
    expect(
      (
        await t.node.handleMessage(
          await fromVerifier(t, "VERDICT", { ...v, verifier_sig: "0".repeat(128) }, tid),
        )
      ).ok,
    ).toBe(false);
    expect(t.node.list()[0]?.state).toBe("DELIVERED");
  });

  it("makes no invoice when the verifier never confirms", async () => {
    const t = await setup({ verifier: true, confirmWaitMs: 30 });
    await t.node.handleOffer(await t.envelope(t.offer));
    await new Promise((r) => setTimeout(r, 120));
    expect(t.node.list()[0]?.state).toBe("REFUSED");
    expect(t.posted.map((p) => p.type)).toEqual(["TASK_ACCEPT"]);
  });
});

describe("extractCode", () => {
  it("strips the markdown fence and thinking leftovers", () => {
    expect(extractCode("<think>x</think>\n\n```js\nconst a = 1;\n```\n")).toBe("const a = 1;\n");
    expect(extractCode("const b = 2;")).toBe("const b = 2;\n");
  });
});
