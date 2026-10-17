import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  contractHash,
  createEd25519Signer,
  type Envelope,
  randomHex32,
  type Signer,
  sealPreimage,
  sha256Hex,
  signPayload,
  type TaskContract,
  taskId,
  verifyPayload,
} from "@verdict/protocol";
import { dirHashFromDisk } from "@verdict/protocol/node";
import { afterAll, describe, expect, it } from "vitest";
import { buildEnvelope } from "./envelope.js";
import { Registry } from "./registry.js";
import { detectSandbox, type RunOptions, type RunResult } from "./runner.js";
import { VerifierService } from "./service.js";

const PKG = resolve(__dirname, "../../../verifier-packages/csv2json-v1");
const GOOD = join(PKG, "fixtures/good-delivery");
const BAD = join(PKG, "fixtures/bad-delivery");
const ENGINE_URL = "http://engine.test";
const WORKER_URL = "http://worker.test";
const sandboxed = detectSandbox() !== null;
const scratch = mkdtempSync(join(tmpdir(), "verifier-svc-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

interface Sent {
  url: string;
  env: Record<string, unknown> & { type: string; body: Record<string, unknown> };
}

async function setup(opts: { run?: (o: RunOptions) => Promise<RunResult> } = {}) {
  const seed = new Uint8Array(32).fill(7);
  const verifier = await createEd25519Signer(seed);
  const engine = await createEd25519Signer(new Uint8Array(32).fill(1));
  const worker = await createEd25519Signer(new Uint8Array(32).fill(2));
  const sent: Sent[] = [];
  const fetchImpl = (async (url: string, init: { body: string }) => {
    sent.push({ url, env: JSON.parse(init.body) });
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  const service = new VerifierService({
    signer: verifier,
    seed,
    packageDir: PKG,
    registry: new Registry(null),
    engineId: engine.publicId,
    engineUrl: ENGINE_URL,
    workerUrl: WORKER_URL,
    fetchImpl,
    preimageRetryMs: [0],
    ...(opts.run ? { run: opts.run } : {}),
  });
  return { service, verifier, engine, worker, sent };
}

async function deposit(
  ctx: Awaited<ReturnType<typeof setup>>,
  over: { packageSha?: string; preimage?: string; hash?: string } = {},
) {
  const preimage = over.preimage ?? randomHex32();
  const body = {
    version: "verdict-task/0" as const,
    buyer: ctx.engine.publicId,
    worker: ctx.worker.publicId,
    capability_hash: "e".repeat(64),
    intent_sha256: "5".repeat(64),
    payment: {
      asset_id: "rgb:2dkSTbr-jFhznbPmo-TQafzswCN-av4gTsJjX-ttx6CNou5-M98k8Zd",
      amount: "1.00",
      payment_hash: over.hash ?? sha256Hex(Buffer.from(preimage, "hex")),
      payee_node_id: `02${"9".repeat(64)}`,
      expiry_blocks: 42,
      expiry_seconds: 3600,
    },
    task: {
      category: "code",
      spec: "csv2json",
      deadline: new Date(Date.now() + 20 * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z"),
      max_verify_seconds: 30,
    },
    verifier: {
      public_id: ctx.verifier.publicId,
      endpoint: "http://verifier.test",
      package_sha256: over.packageSha ?? (await dirHashFromDisk(PKG)),
      entrypoint: "./verify.sh",
      rule: "EXIT_0_AND_SCHEMA_VALID" as const,
    },
    max_lock_seconds: 28800,
    safety_margin_seconds: 600,
  };
  const contract: TaskContract = {
    ...body,
    signatures: {
      buyer: await signPayload(ctx.engine, "TASK_CONTRACT", body),
      worker: await signPayload(ctx.worker, "TASK_CONTRACT", body),
    },
  };
  const tid = taskId(contract);
  const env = (await buildEnvelope(
    ctx.engine,
    "P_DEPOSIT",
    tid,
    ctx.verifier.publicId,
    { contract, sealed_preimage: await sealPreimage(preimage, ctx.verifier.publicId) },
    new Date(),
  )) as unknown as Envelope;
  return { answer: await ctx.service.handle(env), contract, tid, preimage };
}

function bundle(dir: string): { b64: string; sha: string } {
  const out = join(scratch, `b-${Math.random().toString(16).slice(2)}.tar.gz`);
  // ustar without AppleDouble metadata so the bundle is the same on macOS (bsdtar) and Linux (GNU tar).
  const r = spawnSync("tar", ["--format", "ustar", "-czf", out, "-C", dir, "."], {
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
  if (r.status !== 0) throw new Error("tar failed");
  const b64 = readFileSync(out).toString("base64");
  return { b64, sha: "" };
}

async function deliver(
  ctx: Awaited<ReturnType<typeof setup>>,
  d: { tid: string; contract: TaskContract },
  dir: string,
  opts: { announced?: string; from?: Signer; attempt?: number; selfCheck?: number } = {},
) {
  const { b64 } = bundle(dir);
  const env = (await buildEnvelope(
    opts.from ?? ctx.worker,
    "DELIVER",
    d.tid,
    ctx.verifier.publicId,
    {
      attempt: opts.attempt ?? 1,
      delivery_sha256: opts.announced ?? (await dirHashFromDisk(dir)),
      bundle_b64: b64,
      self_check_exit_code: opts.selfCheck ?? 0,
    },
    new Date(),
  )) as unknown as Envelope;
  const a = await ctx.service.handle(env);
  await ctx.service.idle();
  return a;
}

const ofType = (ctx: { sent: Sent[] }, type: string) => ctx.sent.filter((s) => s.env.type === type);

describe("P_DEPOSIT", () => {
  it("confirms to the worker and the engine when sha256(P) = H and the package hash matches", async () => {
    const ctx = await setup();
    const d = await deposit(ctx);
    expect(d.answer.ok).toBe(true);
    const conf = ofType(ctx, "P_CONFIRM");
    expect(conf.map((c) => c.url).sort()).toEqual([
      `${ENGINE_URL}/v0/messages`,
      `${WORKER_URL}/v0/messages`,
    ]);
    expect(conf[0]?.env.body).toMatchObject({ confirmed: true, task_id: d.tid });
    expect(JSON.stringify(ctx.sent)).not.toContain(d.preimage);
  });

  it("refuses a sealed secret that does not hash to the payment hash", async () => {
    const ctx = await setup();
    const d = await deposit(ctx, { hash: "a".repeat(64) });
    expect(d.answer).toMatchObject({ ok: false, code: "PREIMAGE_MISMATCH" });
    expect(ctx.sent).toHaveLength(0);
  });

  it("refuses a contract that names a different verifier package", async () => {
    const ctx = await setup();
    const d = await deposit(ctx, { packageSha: "b".repeat(64) });
    expect(d.answer).toMatchObject({ ok: false, code: "PACKAGE_HASH_MISMATCH" });
    expect(ctx.sent).toHaveLength(0);
  });
});

describe.skipIf(!sandboxed)("DELIVER (real sandboxed runner)", () => {
  it("PASS: signs RELEASE, sends VERDICT to engine and worker, then the preimage to the worker only", async () => {
    const ctx = await setup();
    const d = await deposit(ctx);
    const a = await deliver(ctx, d, GOOD);
    expect(a.ok).toBe(true);
    const verdicts = ofType(ctx, "VERDICT");
    expect(verdicts).toHaveLength(2);
    const record = verdicts[0]?.env.body as Record<string, unknown>;
    expect(record).toMatchObject({ verdict: "RELEASE", exit_code: 0, attempt: 1 });
    expect(record.contract_sha256).toBe(
      contractHash(d.contract as unknown as Record<string, unknown>),
    );
    const { verifier_sig, ...unsigned } = record;
    expect(
      await verifyPayload("VERDICT", unsigned, ctx.verifier.publicId, String(verifier_sig)),
    ).toBe(true);
    const pre = ofType(ctx, "PREIMAGE");
    expect(pre).toHaveLength(1);
    expect(pre[0]?.url).toBe(`${WORKER_URL}/v0/messages`);
    expect(pre[0]?.env.body).toMatchObject({ preimage_hex: d.preimage, reason: "VERDICT_RELEASE" });
    expect(
      await ctx.service.handle(
        (await buildEnvelope(
          ctx.worker,
          "DELIVER",
          d.tid,
          ctx.verifier.publicId,
          {
            attempt: 2,
            delivery_sha256: "0".repeat(64),
            bundle_b64: "",
            self_check_exit_code: 0,
          },
          new Date(),
        )) as unknown as Envelope,
      ),
    ).toMatchObject({ ok: false });
  });

  it("FAIL is final: signs WITHHOLD, never opens or sends the preimage, and refuses a redelivery (M5)", async () => {
    const ctx = await setup();
    const d = await deposit(ctx);
    await deliver(ctx, d, BAD, { attempt: 1 });
    const again = await deliver(ctx, d, BAD, { attempt: 2 });
    expect(again).toMatchObject({ ok: false });
    expect(ofType(ctx, "PREIMAGE")).toHaveLength(0);
    expect(JSON.stringify(ctx.sent)).not.toContain(d.preimage);
    const verdicts = ofType(ctx, "VERDICT").filter((v) => v.url.startsWith(ENGINE_URL));
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]?.env.body).toMatchObject({ verdict: "WITHHOLD", exit_code: 1 });
    const report = ctx.service.reports()[0]?.reports[0];
    expect(report).toMatchObject({ outcome: "FAIL", sandbox: expect.any(String) });
    expect(report?.log_tail.join("\n")).toContain('"id":"tests","status":"fail"');
  });

  it("a delivery that differs from its announced hash is WITHHOLD and is not run", async () => {
    let ran = false;
    const ctx = await setup({
      run: async () => {
        ran = true;
        throw new Error("must not run");
      },
    });
    const d = await deposit(ctx);
    await deliver(ctx, d, GOOD, { announced: "0".repeat(64) });
    expect(ran).toBe(false);
    expect(ofType(ctx, "VERDICT")[0]?.env.body).toMatchObject({
      verdict: "WITHHOLD",
      exit_code: -1,
    });
    expect(ctx.service.reports()[0]?.reports[0]?.code).toBe("DELIVERY_HASH_MISMATCH");
    expect(ofType(ctx, "PREIMAGE")).toHaveLength(0);
  });
});

describe("fail closed", () => {
  it("a runner that throws or times out never releases", async () => {
    const ctx = await setup({
      run: async () => ({
        outcome: "WITHHOLD",
        exitCode: null,
        checks: [],
        sandbox: "bwrap",
        code: "VERIFY_TIMEOUT",
        message: "Verification timed out.",
      }),
    });
    const d = await deposit(ctx);
    await deliver(ctx, d, GOOD);
    expect(ofType(ctx, "VERDICT")[0]?.env.body).toMatchObject({
      verdict: "WITHHOLD",
      exit_code: -1,
    });
    expect(ofType(ctx, "PREIMAGE")).toHaveLength(0);
    expect(ctx.service.reports()[0]?.reports[0]?.code).toBe("VERIFY_TIMEOUT");
  });

  it("a delivery from anyone but the contract's worker is refused", async () => {
    const ctx = await setup();
    const d = await deposit(ctx);
    const stranger = await createEd25519Signer(new Uint8Array(32).fill(9));
    const a = await deliver(ctx, d, GOOD, { from: stranger });
    expect(a).toMatchObject({ ok: false, code: "SIGNATURE_INVALID" });
    expect(ofType(ctx, "VERDICT")).toHaveLength(0);
  });
});

describe("RunReport.v2 and /v0/stats", () => {
  const fakeRun = (outcome: "PASS" | "FAIL") => async (): Promise<RunResult> => ({
    outcome,
    exitCode: outcome === "PASS" ? 0 : 1,
    checks: [
      { id: "tests", status: outcome === "PASS" ? "pass" : "fail" },
      { id: "schema", status: "pass" },
    ],
    sandbox: "bwrap",
    message: "x",
  });

  it("keeps the worker's self-check code as evidence, outside the signed record", async () => {
    const ctx = await setup({ run: fakeRun("FAIL") });
    const d = await deposit(ctx);
    await deliver(ctx, d, GOOD, { selfCheck: 0 });
    const report = ctx.service.reports()[0]?.reports[0];
    expect(report?.v2).toMatchObject({
      package_sha256: d.contract.verifier.package_sha256,
      package_id: "csv2json-v1",
      profile: null,
      score: null,
      min_score: null,
      determinism: "skipped",
      self_check_exit_code: 0,
      self_check_agrees: false,
      sandbox: "bwrap",
    });
    expect(report?.v2?.duration_ms).toBeGreaterThanOrEqual(0);
    expect(report?.v2?.checks[0]).toEqual({
      id: "tests",
      kind: null,
      weight: null,
      required: true,
      status: "fail",
      ms: null,
    });
    expect(Object.keys(report?.record ?? {})).not.toContain("v2");
  });

  it("computes per-package statistics from the registry", async () => {
    const ctx = await setup({ run: fakeRun("PASS") });
    const d = await deposit(ctx);
    await deliver(ctx, d, GOOD, { selfCheck: 0 });
    const stats = ctx.service.stats();
    expect(stats.packages).toEqual([
      {
        package_sha256: d.contract.verifier.package_sha256,
        package_id: "csv2json-v1",
        format: 1,
        profile: null,
        runs: 1,
        pass: 1,
        pass_rate: 1,
        mean_score: null,
        median_duration_ms: expect.any(Number),
        determinism_rate: null,
        self_check_agreement: 1,
        checks: [
          { id: "tests", runs: 1, fail_rate: 0 },
          { id: "schema", runs: 1, fail_rate: 0 },
        ],
        withhold_codes: {},
      },
    ]);
  });

  it("carries the format-2 score, profile, weights and determinism into the report and the stats", async () => {
    const ctx = await setup({
      run: async (): Promise<RunResult> => ({
        outcome: "PASS",
        exitCode: 0,
        checks: [
          { id: "fixtures", status: "pass", kind: "fixtures", weight: 50, required: true, ms: 0 },
          { id: "visible", status: "fail", kind: "fixtures", weight: 10, required: false, ms: 0 },
        ],
        sandbox: "bwrap",
        message: "x",
        score: 83.33,
        min_score: 80,
        profile: "standard",
        packageId: "json-norm",
        determinism: "match",
      }),
    });
    const d = await deposit(ctx);
    await deliver(ctx, d, GOOD);
    const v2 = ctx.service.reports()[0]?.reports[0]?.v2;
    expect(v2).toMatchObject({
      package_id: "json-norm",
      profile: "standard",
      score: 83.33,
      min_score: 80,
      determinism: "match",
    });
    expect(v2?.checks[1]).toEqual({
      id: "visible",
      kind: "fixtures",
      weight: 10,
      required: false,
      status: "fail",
      ms: 0,
    });
    expect(ctx.service.stats().packages[0]).toMatchObject({
      format: 2,
      profile: "standard",
      mean_score: 83.33,
      determinism_rate: 1,
    });
  });
});
