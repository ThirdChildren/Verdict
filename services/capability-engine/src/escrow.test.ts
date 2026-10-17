import { createHash, randomBytes } from "node:crypto";
import {
  type ChildCapability,
  capId,
  contractHash,
  createEd25519Signer,
  hashObj,
  type OfferedContract,
  openPreimage,
  type RootCapability,
  type Signer,
  type SpendIntent,
  signPayload,
  type TaskContract,
  taskId,
} from "@verdict/protocol";
import { FakeHub, FakeWallet } from "@verdict/wallet";
import { describe, expect, it } from "vitest";
import { EventBus } from "./events.js";
import { Ledger } from "./ledger/index.js";
import * as k from "./policy/testkit.js";
import { buildServer } from "./server.js";

const seed = (n: number) => new Uint8Array(32).fill(n);
const AMT_MSAT = 3_000_000n;
const VERIFIER_SEED = seed(5);

async function setup() {
  const [principal, engine, buyer, worker] = await Promise.all(
    [1, 2, 3, 4].map((n) => createEd25519Signer(seed(n))),
  );
  const hub = new FakeHub();
  const buyerWallet = new FakeWallet(`02${"b1".repeat(32)}`, hub);
  const workerWallet = new FakeWallet(`02${"c2".repeat(32)}`, hub);
  let pays = 0;
  const realPay = buyerWallet.pay.bind(buyerWallet);
  buyerWallet.pay = async (b: string) => {
    pays++;
    return realPay(b);
  };
  const ledger = Ledger.open(":memory:", k.P);
  const verifier = await createEd25519Signer(VERIFIER_SEED);
  const offers: { type: string; body: OfferedContract }[] = [];
  const workerNode = await workerWallet.nodeId();
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith("/v0/info"))
      return Response.json({ public_id: worker!.publicId, node_id: workerNode });
    const env = JSON.parse(String(init?.body)) as { type: string; body: OfferedContract };
    offers.push(env);
    return Response.json({ ok: true });
  }) as typeof fetch;
  const bus = new EventBus();
  const deposits: { type: string; body: unknown }[] = [];
  const verifierFetch = (async (_u: string | URL | Request, init?: RequestInit) => {
    deposits.push(JSON.parse(String(init?.body)));
    return Response.json({ ok: true });
  }) as typeof fetch;
  const app = await buildServer({
    verifierFetch,
    logger: false,
    ledger,
    bus,
    precision: k.P,
    now: () => k.NOW,
    identities: {
      principal: principal!.publicId,
      engine: engine!.publicId,
      buyer: buyer!.publicId,
      verifier: verifier.publicId,
    },
    engineSigner: engine!,
    limits: { max_root_amount: "500.00", max_root_expiry_seconds: 86_400 },
    preapprovedWorkers: [worker!.publicId],
    wallet: buyerWallet,
    assetId: k.ASSET,
    offer: {
      verifier: {
        publicId: verifier.publicId,
        endpoint: "http://127.0.0.1:7404",
        packageSha256: "7".repeat(64),
      },
      workerUrl: "http://worker.test",
      maxLockSeconds: k.contract.max_lock_seconds,
      safetyMarginSeconds: k.contract.safety_margin_seconds,
      maxVerifySeconds: k.contract.task.max_verify_seconds,
      expirySeconds: 3600,
      expiryBlocks: 24,
      fetchImpl,
    },
  });
  const base = {
    ...k.root,
    issuer: principal!.publicId,
    max_total: "5.00",
    max_per_task: "2.00",
    allowed_payees: [worker!.publicId],
    expires_at: "2026-10-18T17:00:00Z",
  } as RootCapability;
  const withId = { ...base, cap_id: capId(base) };
  const root = { ...withId, signature: await signPayload(principal!, "CAP_ROOT", withId) };
  const m = await app.inject({ method: "POST", url: "/api/mandate", payload: { root } });
  const capHash = (m.json() as { cap_hash: string }).cap_hash;
  const child = ledger.getCapability(capHash) as ChildCapability;
  return {
    app,
    ledger,
    bus,
    engine: engine!,
    worker: worker!,
    buyerWallet,
    workerWallet,
    capHash,
    child,
    pays: () => pays,
    buyer: buyer!,
    offers,
    verifier,
    deposits,
  };
}
type Ctx = Awaited<ReturnType<typeof setup>>;

async function post(
  app: Ctx["app"],
  from: Signer,
  to: Signer,
  type: string,
  tid: string,
  body: unknown,
) {
  const env: Record<string, unknown> = {
    v: 0,
    id: crypto.randomUUID(),
    task_id: tid,
    from: from.publicId,
    to: to.publicId,
    sent_at: k.NOW.toISOString(),
    type,
    body,
  };
  env.sig = await signPayload(from, type, env);
  return app.inject({ method: "POST", url: "/v0/messages", payload: env });
}

const intentFor = (c: Ctx, over: Partial<SpendIntent> = {}): SpendIntent => ({
  kind: "task_payment",
  category: "code",
  counterparty: c.worker.publicId,
  amount: "1.20",
  recurring: false,
  interval: null,
  task_spec: "Build a CSV-to-JSON CLI",
  deadline: "2026-10-18T16:00:00Z",
  rationale: "needed",
  ...over,
});

/** The buyer signs a spend intent; the engine accepts it and builds the offer (setImmediate), which we wait for. */
async function offerFromIntent(c: Ctx, over: Partial<SpendIntent> = {}) {
  const intent = intentFor(c, over);
  const before = c.offers.length;
  const r = await post(c.app, c.buyer, c.engine, "SPEND_INTENT", "task_0000000000000000", {
    cap_hash: c.capHash,
    intent,
  });
  expect(r.statusCode).toBe(200);
  for (let i = 0; i < 100 && c.offers.length === before; i++)
    await new Promise((res) => setTimeout(res, 10));
  const sent = c.offers[before];
  if (!sent)
    throw new Error(
      `the engine built no offer: ${JSON.stringify(c.bus.replay().filter((e) => e.type === "BLOCKED"))}`,
    );
  return { intent, offer: sent.body, intentSha: hashObj({ cap_hash: c.capHash, intent }) };
}

/** What a worker does: countersign the unsigned body. `edit` builds a tampered contract for refusal tests. */
async function countersign(
  c: Ctx,
  offer: OfferedContract,
  edit: (b: Record<string, unknown>) => Record<string, unknown> = (b) => b,
  workerSigner: Signer = c.worker,
  buyerSigner: Signer = c.engine,
): Promise<TaskContract> {
  const { signatures: _s, ...unsigned } = offer;
  const base = edit({ ...unsigned });
  return {
    ...base,
    signatures: {
      buyer: await signPayload(buyerSigner, "TASK_CONTRACT", base),
      worker: await signPayload(workerSigner, "TASK_CONTRACT", base),
    },
  } as unknown as TaskContract;
}

const newPair = () => {
  const p = randomBytes(32);
  return { preimage: p.toString("hex"), hash: createHash("sha256").update(p).digest("hex") };
};
const invoice = (c: Ctx, hash: string, units: bigint) =>
  c.workerWallet.createHodlInvoice({
    paymentHash: hash,
    assetId: k.ASSET,
    assetAmount: units,
    amtMsat: AMT_MSAT,
    expirySec: 3600,
    minFinalCltvExpiryDelta: 5,
  });

/** What the verifier does after P_DEPOSIT: P_CONFIRM to the engine. */
async function pConfirm(
  c: Ctx,
  tid: string,
  contract: TaskContract,
  over: Record<string, unknown> = {},
) {
  return post(c.app, c.verifier, c.engine, "P_CONFIRM", tid, {
    task_id: tid,
    payment_hash: contract.payment.payment_hash,
    package_sha256: contract.verifier.package_sha256,
    confirmed: true,
    ...over,
  });
}

async function accepted(c: Ctx, confirm = true) {
  const { offer } = await offerFromIntent(c);
  const contract = await countersign(c, offer);
  const tid = taskId(contract);
  const r = await post(c.app, c.worker, c.engine, "TASK_ACCEPT", tid, contract);
  expect(r.statusCode).toBe(200);
  const hash = contract.payment.payment_hash;
  for (let i = 0; i < 100 && c.deposits.length === 0; i++)
    await new Promise((res) => setTimeout(res, 10));
  if (confirm) await pConfirm(c, tid, contract);
  return { hash, contract, preimage: c.ledger.preimageFor(hash) as string, tid };
}
const budget = (c: Ctx) => {
  const e = [...c.bus.replay()]
    .reverse()
    .find((x) => x.type === "BUDGET_UPDATED" && x.data.cap_id === c.child.cap_id);
  return e?.type === "BUDGET_UPDATED" ? e.data : undefined;
};

describe("engine <-> wallet escrow (FakeWallet)", () => {
  it("reserve, pay, claim with P -> committed", async () => {
    const c = await setup();
    const t = await accepted(c);
    const inv = await invoice(c, t.hash, 120n);
    const r = await post(c.app, c.worker, c.engine, "HODL_INVOICE", t.tid, {
      bolt11: inv.bolt11,
      payment_hash: t.hash,
    });
    expect(r.json()).toMatchObject({ ok: true, status: "Pending" });
    expect(budget(c)).toMatchObject({ reserved: "1.20", committed: "0.00" });
    await c.workerWallet.claimHodlInvoice(t.hash, t.preimage);
    expect(budget(c)).toMatchObject({ reserved: "0.00", committed: "1.20" });
    await c.app.close();
  });

  it("worker cancels -> released, budget back", async () => {
    const c = await setup();
    const t = await accepted(c);
    const inv = await invoice(c, t.hash, 120n);
    await post(c.app, c.worker, c.engine, "HODL_INVOICE", t.tid, {
      bolt11: inv.bolt11,
      payment_hash: t.hash,
    });
    await c.workerWallet.cancelHodlInvoice(t.hash);
    expect(budget(c)).toMatchObject({ reserved: "0.00", committed: "0.00", remaining: "2.00" });
    expect(c.bus.replay().some((e) => e.type === "REFUNDED")).toBe(true);
    await c.app.close();
  });

  it("invoice with a different payment hash or amount is refused before any reservation", async () => {
    const c = await setup();
    const t = await accepted(c);
    const other = newPair();
    const wrongHash = await invoice(c, other.hash, 120n);
    const r1 = await post(c.app, c.worker, c.engine, "HODL_INVOICE", t.tid, {
      bolt11: wrongHash.bolt11,
      payment_hash: t.hash,
    });
    expect(r1.statusCode).toBe(422);
    expect(r1.json()).toMatchObject({ code: "INVOICE_HASH_MISMATCH" });
    const wrongAmount = await invoice(c, t.hash, 130n);
    const r2 = await post(c.app, c.worker, c.engine, "HODL_INVOICE", t.tid, {
      bolt11: wrongAmount.bolt11,
      payment_hash: t.hash,
    });
    expect(r2.json()).toMatchObject({ code: "INVOICE_AMOUNT_MISMATCH" });
    expect(c.pays()).toBe(0);
    expect(c.ledger.getByPaymentHash(t.hash)).toBeUndefined();
    expect(c.ledger.remaining(c.capHash)).toBe(200n);
    await c.app.close();
  });

  it("a repeated invoice never pays twice; an unknown contract is refused", async () => {
    const c = await setup();
    const t = await accepted(c);
    const inv = await invoice(c, t.hash, 120n);
    const body = { bolt11: inv.bolt11, payment_hash: t.hash };
    await post(c.app, c.worker, c.engine, "HODL_INVOICE", t.tid, body);
    const again = await post(c.app, c.worker, c.engine, "HODL_INVOICE", t.tid, body);
    expect(again.json()).toMatchObject({ ok: true, duplicate: true });
    expect(c.pays()).toBe(1);
    const stranger = newPair();
    const si = await invoice(c, stranger.hash, 120n);
    const r = await post(c.app, c.worker, c.engine, "HODL_INVOICE", t.tid, {
      bolt11: si.bolt11,
      payment_hash: stranger.hash,
    });
    expect(r.json()).toMatchObject({ code: "INVOICE_HASH_MISMATCH" });
    expect(c.pays()).toBe(1);
    await c.app.close();
  });

  it("concurrent invoices with the same bolt11 pay exactly once", async () => {
    const c = await setup();
    const t = await accepted(c);
    const inv = await invoice(c, t.hash, 120n);
    const body = { bolt11: inv.bolt11, payment_hash: t.hash };
    const rs = await Promise.all(
      [0, 1, 2, 3, 4].map(() => post(c.app, c.worker, c.engine, "HODL_INVOICE", t.tid, body)),
    );
    expect(rs.map((r) => r.json()).every((j) => (j as { ok: boolean }).ok)).toBe(true);
    expect(rs.filter((r) => (r.json() as { duplicate: boolean }).duplicate === false)).toHaveLength(
      1,
    );
    expect(c.pays()).toBe(1);
    await c.app.close();
  });

  it("lock window shorter than deadline + verify + margin is refused", async () => {
    const c = await setup();
    const t = await accepted(c);
    const inv = await c.workerWallet.createHodlInvoice({
      paymentHash: t.hash,
      assetId: k.ASSET,
      assetAmount: 120n,
      amtMsat: AMT_MSAT,
      expirySec: 3600,
      minFinalCltvExpiryDelta: 1,
    });
    const r = await post(c.app, c.worker, c.engine, "HODL_INVOICE", t.tid, {
      bolt11: inv.bolt11,
      payment_hash: t.hash,
    });
    expect(r.json()).toMatchObject({ code: "LOCK_WINDOW_TOO_SHORT" });
    expect(c.pays()).toBe(0);
    await c.app.close();
  });

  it("builds an offer signed by the engine, with H, and P sealed to the verifier only", async () => {
    const c = await setup();
    const { offer, intentSha } = await offerFromIntent(c);
    expect(offer.intent_sha256).toBe(intentSha);
    expect(offer.signatures.worker).toBeUndefined();
    expect(offer.buyer).toBe(c.engine.publicId);
    const p = c.ledger.preimageFor(offer.payment.payment_hash) as string;
    expect(createHash("sha256").update(Buffer.from(p, "hex")).digest("hex")).toBe(
      offer.payment.payment_hash,
    );
    const sealed = c.ledger.getOfferByIntent(intentSha)?.sealedPreimage as string;
    expect(await openPreimage(sealed, VERIFIER_SEED)).toBe(p);
    expect(JSON.stringify(offer)).not.toContain(p);
    expect(JSON.stringify(c.bus.replay())).not.toContain(p);
    await c.app.close();
  });

  it("contract amount above the intent, wrong worker, or a forged offer is refused before any reservation", async () => {
    const c = await setup();
    const { offer } = await offerFromIntent(c);
    const pay = (b: Record<string, unknown>) => ({
      ...b,
      payment: { ...(b.payment as object), amount: "1.50" },
    });
    const over = await countersign(c, offer, pay);
    const r1 = await post(c.app, c.worker, c.engine, "TASK_ACCEPT", taskId(over), over);
    expect(r1.statusCode).toBe(422);
    expect(r1.json()).toMatchObject({ code: "MALFORMED_INTENT" });
    expect(r1.json().message).toContain("1.50");

    const other = await createEd25519Signer(seed(9));
    const wrong = await countersign(c, offer, (b) => ({ ...b, worker: other.publicId }), other);
    const r2 = await post(c.app, other, c.engine, "TASK_ACCEPT", taskId(wrong), wrong);
    expect(r2.statusCode).toBe(422);
    expect(r2.json()).toMatchObject({ code: "COUNTERPARTY_NOT_ALLOWED" });

    // Same amount and worker, but not the offer the engine signed (different spec).
    const forged = await countersign(c, offer, (b) => ({
      ...b,
      task: { ...(b.task as object), spec: "Do something else" },
    }));
    const r3 = await post(c.app, c.worker, c.engine, "TASK_ACCEPT", taskId(forged), forged);
    expect(r3.statusCode).toBe(422);
    expect(contractHash(forged as unknown as Record<string, unknown>)).not.toBe(
      contractHash(offer as unknown as Record<string, unknown>),
    );
    expect(c.ledger.getContract(offer.payment.payment_hash)).toBeUndefined();
    expect(c.ledger.getByPaymentHash(offer.payment.payment_hash)).toBeUndefined();
    expect(c.ledger.remaining(c.capHash)).toBe(200n);
    await c.app.close();
  });

  it("a contract without intent_sha256 is refused before any reservation", async () => {
    const c = await setup();
    const { offer } = await offerFromIntent(c);
    const noLink = await countersign(c, offer, (b) => {
      const { intent_sha256: _i, ...rest } = b;
      return rest;
    });
    const r = await post(c.app, c.worker, c.engine, "TASK_ACCEPT", "task_0000000000000000", noLink);
    expect(r.statusCode).toBeGreaterThanOrEqual(400);
    expect(r.json()).toMatchObject({ code: "MALFORMED_INTENT" });
    expect(c.ledger.getContract(offer.payment.payment_hash)).toBeUndefined();
    expect(c.ledger.remaining(c.capHash)).toBe(200n);
    await c.app.close();
  });

  it("never pays a hash the wallet already knows", async () => {
    const c = await setup();
    const t = await accepted(c);
    const inv = await invoice(c, t.hash, 120n);
    const prePaid = await c.buyerWallet.pay(inv.bolt11); // simulates a lost answer after a send
    expect(prePaid.status).toBe("Pending");
    const r = await post(c.app, c.worker, c.engine, "HODL_INVOICE", t.tid, {
      bolt11: inv.bolt11,
      payment_hash: t.hash,
    });
    expect(r.json()).toMatchObject({ ok: true, duplicate: true });
    expect(c.pays()).toBe(1);
    await c.app.close();
  });

  it("no payment starts before the verifier confirms it holds the secret", async () => {
    const c = await setup();
    const t = await accepted(c, false);
    expect(c.deposits.map((d) => d.type)).toEqual(["P_DEPOSIT"]);
    const inv = await invoice(c, t.hash, 120n);
    const r = await post(c.app, c.worker, c.engine, "HODL_INVOICE", t.tid, {
      bolt11: inv.bolt11,
      payment_hash: t.hash,
    });
    expect(r.statusCode).toBeGreaterThanOrEqual(400);
    expect(r.json().message).toContain("verifier has not confirmed");
    expect(c.pays()).toBe(0);
    expect(c.ledger.remaining(c.capHash)).toBe(200n);
    // A confirmation from anyone but the verifier changes nothing.
    const bad = await post(c.app, c.worker, c.engine, "P_CONFIRM", t.tid, {
      task_id: t.tid,
      payment_hash: t.hash,
      package_sha256: t.contract.verifier.package_sha256,
      confirmed: true,
    });
    expect(bad.statusCode).toBeGreaterThanOrEqual(400);
    expect(c.ledger.hasPConfirm(t.hash)).toBe(false);
    await c.app.close();
  });

  async function verdictFor(
    c: Ctx,
    t: Awaited<ReturnType<typeof accepted>>,
    verdict: "RELEASE" | "WITHHOLD",
    over: Record<string, unknown> = {},
  ) {
    const unsigned = {
      task_id: t.tid,
      contract_sha256: contractHash(t.contract as unknown as Record<string, unknown>),
      delivery_sha256: "2".repeat(64),
      verifier_package_sha256: t.contract.verifier.package_sha256,
      attempt: 1,
      checks: [
        { id: "tests", status: verdict === "RELEASE" ? ("PASS" as const) : ("FAIL" as const) },
      ],
      exit_code: verdict === "RELEASE" ? 0 : 1,
      verdict,
      payment_hash: t.hash,
      timestamp: 1760790000,
      ...over,
    };
    return post(c.app, c.verifier, c.engine, "VERDICT", t.tid, {
      ...unsigned,
      verifier_sig: await signPayload(c.verifier, "VERDICT", unsigned),
    });
  }
  const states = (c: Ctx) =>
    c.bus.replay().flatMap((e) => (e.type === "TASK_STATE" ? [e.data.state] : []));

  it("a RELEASE verdict is recorded and shown; the claim then commits and the task ends CLAIMED", async () => {
    const c = await setup();
    const t = await accepted(c);
    const inv = await invoice(c, t.hash, 120n);
    await post(c.app, c.worker, c.engine, "HODL_INVOICE", t.tid, {
      bolt11: inv.bolt11,
      payment_hash: t.hash,
    });
    const r = await verdictFor(c, t, "RELEASE");
    expect(r.json()).toMatchObject({ ok: true });
    expect(c.bus.replay().some((e) => e.type === "VERDICT" && e.data.verdict === "RELEASE")).toBe(
      true,
    );
    expect(c.ledger.verdictsFor(t.hash)).toHaveLength(1);
    // Budget does not move on a verdict, only on the wallet event.
    expect(budget(c)).toMatchObject({ reserved: "1.20", committed: "0.00" });
    await c.workerWallet.claimHodlInvoice(t.hash, t.preimage);
    expect(budget(c)).toMatchObject({ reserved: "0.00", committed: "1.20" });
    expect(states(c)).toEqual([
      "OFFERED",
      "ACCEPTED",
      "P_DEPOSITED",
      "P_CONFIRMED",
      "INVOICE_RECEIVED",
      "ESCROW_LOCKED",
      "DELIVERED",
      "VERDICT_RELEASE",
      "CLAIMED",
    ]);
    await c.app.close();
  });

  it("a WITHHOLD verdict then a cancelled invoice releases the budget and ends REFUNDED", async () => {
    const c = await setup();
    const t = await accepted(c);
    const inv = await invoice(c, t.hash, 120n);
    await post(c.app, c.worker, c.engine, "HODL_INVOICE", t.tid, {
      bolt11: inv.bolt11,
      payment_hash: t.hash,
    });
    await verdictFor(c, t, "WITHHOLD");
    expect(budget(c)).toMatchObject({ reserved: "1.20" });
    await c.workerWallet.cancelHodlInvoice(t.hash);
    expect(budget(c)).toMatchObject({ reserved: "0.00", committed: "0.00" });
    expect(states(c).slice(-4)).toEqual(["DELIVERED", "VERDICT_WITHHOLD", "EXPIRED", "REFUNDED"]);
    await c.app.close();
  });

  it("a verdict for another contract, from another signer, or with a bad signature is refused", async () => {
    const c = await setup();
    const t = await accepted(c);
    const wrongContract = await verdictFor(c, t, "RELEASE", { contract_sha256: "9".repeat(64) });
    expect(wrongContract.statusCode).toBeGreaterThanOrEqual(400);
    const wrongPackage = await verdictFor(c, t, "RELEASE", {
      verifier_package_sha256: "9".repeat(64),
    });
    expect(wrongPackage.statusCode).toBeGreaterThanOrEqual(400);
    const impostor = await post(c.app, c.worker, c.engine, "VERDICT", t.tid, {
      task_id: t.tid,
      contract_sha256: contractHash(t.contract as unknown as Record<string, unknown>),
      delivery_sha256: "2".repeat(64),
      verifier_package_sha256: t.contract.verifier.package_sha256,
      attempt: 1,
      checks: [],
      exit_code: 0,
      verdict: "RELEASE",
      payment_hash: t.hash,
      timestamp: 1760790000,
      verifier_sig: "0".repeat(128),
    });
    expect(impostor.statusCode).toBeGreaterThanOrEqual(400);
    expect(c.ledger.verdictsFor(t.hash)).toHaveLength(0);
    expect(c.bus.replay().some((e) => e.type === "VERDICT")).toBe(false);
    await c.app.close();
  });
});
