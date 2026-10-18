import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createEd25519Signer,
  type Envelope,
  randomHex32,
  type Signer,
  sealPreimage,
  sha256Hex,
  signPayload,
  type TaskContract,
  taskId,
} from "@verdict/protocol";
import { dirHashFromDisk } from "@verdict/protocol/node";
import { afterAll, describe, expect, it } from "vitest";
import { Catalogue } from "../catalogue.js";
import { EventBus } from "../events.js";
import { Ledger } from "../ledger/index.js";
import * as k from "../policy/testkit.js";
import { buildServer } from "../server.js";

// E33 end to end with fakes, in one process: engine route -> temp root -> real verifier service and sandboxed runner.
// The verifier is read through variable paths to stay outside this project's tsc rootDir (same trick as task-types.test.ts).
const V = "../../../verifier/src/";
// biome-ignore lint/suspicious/noExplicitAny: the verifier modules are loaded by a variable path, so they are untyped here
type Loose = any;
const load = async (f: string): Promise<Loose> => await import(/* @vite-ignore */ `${V}${f}`);
const runner = await load("runner.js");
const verifierCatalogue = await load("catalogue.js");
const verifierService = await load("service.js");
const verifierRegistry = await load("registry.js");
const verifierEnvelope = await load("envelope.js");
const sandboxed = runner.detectSandbox() !== null;

const scratch = mkdtempSync(join(tmpdir(), "custom-e2e-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const draft = (over: Record<string, unknown> = {}) => ({
  feasibility: "cli",
  reason: "A program can read two numbers and print their sum.",
  title: "Sum two numbers",
  description: "Read a text file with two integers on one line and print their sum.",
  entry: "sum-numbers.mjs",
  input_ext: ".txt",
  visible: [
    { input: "1 2\n", expected: "3\n" },
    { input: "10 5\n", expected: "15\n" },
    { input: "0 0\n", expected: "0\n" },
  ],
  hidden: [
    { input: "7 8\n", expected: "15\n" },
    { input: "-3 3\n", expected: "0\n" },
    { input: "100 250\n", expected: "350\n" },
    { input: "999 1\n", expected: "1000\n" },
    { input: "-5 -6\n", expected: "-11\n" },
  ],
  assertions: { max_output_bytes: 64 },
  ...over,
});

const REFERENCE = `import { readFileSync } from "node:fs";
const [a, b] = readFileSync(process.argv[2], "utf8").trim().split(/\\s+/).map(Number);
process.stdout.write(\`\${a + b}\\n\`);
`;
const WRONG = `process.stdout.write("3\\n");\n`;

function delivery(source: string): string {
  const dir = mkdtempSync(join(scratch, "del-"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "sum-numbers.mjs"), source);
  return dir;
}
function bundle(dir: string): string {
  const out = join(scratch, `b-${Math.random().toString(16).slice(2)}.tar.gz`);
  const r = spawnSync("tar", ["--format", "ustar", "-czf", out, "-C", dir, "."], {
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
  if (r.status !== 0) throw new Error("tar failed");
  return readFileSync(out).toString("base64");
}

async function world() {
  const root = mkdtempSync(join(scratch, "root-"));
  const vcat = await verifierCatalogue.Catalogue.fromRoot(root);
  const vsigner = await createEd25519Signer(new Uint8Array(32).fill(7));
  const engine = await createEd25519Signer(new Uint8Array(32).fill(1));
  const worker = await createEd25519Signer(new Uint8Array(32).fill(2));
  const sent: { env: { type: string; body: Record<string, unknown> } }[] = [];
  const service = new verifierService.VerifierService({
    signer: vsigner,
    seed: new Uint8Array(32).fill(7),
    catalogue: vcat,
    registry: new verifierRegistry.Registry(null),
    engineId: engine.publicId,
    engineUrl: "http://engine.test",
    workerUrl: "http://worker.test",
    fetchImpl: (async (_u: string, init: { body: string }) => {
      sent.push({ env: JSON.parse(init.body) });
      return new Response("{}");
    }) as unknown as typeof fetch,
    preimageRetryMs: [0],
  });
  // The engine's view of the verifier: a fresh scan of the same root, so the service's own catalogue stays
  // stale until the P_DEPOSIT (or packages()) triggers its rescan.
  const verifierFetch = (async () =>
    new Response(
      JSON.stringify({ packages: (await verifierCatalogue.Catalogue.fromRoot(root)).list() }),
    )) as unknown as typeof fetch;
  const bus = new EventBus();
  const app = await buildServer({
    logger: false,
    ledger: Ledger.open(":memory:", k.P),
    bus,
    catalogue: new Catalogue([]),
    packagesRoot: root,
    verifierUrl: "http://127.0.0.1:7402",
    verifierFetch,
    verifierWaitMs: 500,
    mandateRateLimit: { max: 1000, windowMs: 60_000 },
    identities: { principal: engine.publicId, engine: engine.publicId, buyer: engine.publicId },
    engineSigner: engine,
  });
  const install = async (d: unknown) => {
    const r = await app.inject({ method: "POST", url: "/api/task-types", payload: { draft: d } });
    return {
      status: r.statusCode,
      body: r.json() as { id: string; package_sha256: string; code: string },
    };
  };
  return { root, vcat, vsigner, engine, worker, sent, service, app, install };
}
type World = Awaited<ReturnType<typeof world>>;

async function deposit(w: World, packageSha: string) {
  const preimage = randomHex32();
  const body = {
    version: "verdict-task/0" as const,
    buyer: w.engine.publicId,
    worker: w.worker.publicId,
    capability_hash: "e".repeat(64),
    intent_sha256: "5".repeat(64),
    payment: {
      asset_id: "rgb:2dkSTbr-jFhznbPmo-TQafzswCN-av4gTsJjX-ttx6CNou5-M98k8Zd",
      amount: "1.00",
      payment_hash: sha256Hex(Buffer.from(preimage, "hex")),
      payee_node_id: `02${"9".repeat(64)}`,
      expiry_blocks: 42,
      expiry_seconds: 3600,
    },
    task: {
      category: "code",
      spec: "sum",
      deadline: new Date(Date.now() + 20 * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z"),
      max_verify_seconds: 60,
    },
    verifier: {
      public_id: w.vsigner.publicId,
      endpoint: "http://verifier.test",
      package_sha256: packageSha,
      entrypoint: "./verify.mjs",
      rule: "EXIT_0_AND_SCHEMA_VALID" as const,
    },
    max_lock_seconds: 28800,
    safety_margin_seconds: 600,
  };
  const contract: TaskContract = {
    ...body,
    signatures: {
      buyer: await signPayload(w.engine, "TASK_CONTRACT", body),
      worker: await signPayload(w.worker, "TASK_CONTRACT", body),
    },
  };
  const tid = taskId(contract);
  const env = (await verifierEnvelope.buildEnvelope(
    w.engine,
    "P_DEPOSIT",
    tid,
    w.vsigner.publicId,
    { contract, sealed_preimage: await sealPreimage(preimage, w.vsigner.publicId) },
    new Date(),
  )) as Envelope;
  return { answer: await w.service.handle(env), tid };
}

async function deliver(w: World, tid: string, dir: string, from: Signer = w.worker) {
  const env = (await verifierEnvelope.buildEnvelope(
    from,
    "DELIVER",
    tid,
    w.vsigner.publicId,
    {
      attempt: 1,
      delivery_sha256: await dirHashFromDisk(dir),
      bundle_b64: bundle(dir),
      self_check_exit_code: 0,
    },
    new Date(),
  )) as Envelope;
  await w.service.handle(env);
  await w.service.idle();
  return w.sent.filter((s) => s.env.type === "VERDICT").at(-1)?.env.body;
}

describe("E33 end to end with fakes (engine -> verifier -> sandboxed runner)", () => {
  it("installed hash = directory hash = verifier listing; reinstall is idempotent", async () => {
    const w = await world();
    const a = await w.install(draft());
    expect(a.status).toBe(200);
    const { id, package_sha256 } = a.body as { id: string; package_sha256: string };
    expect(await dirHashFromDisk(join(w.root, id))).toBe(package_sha256);
    const listed = (await w.service.packages()) as { id: string; hash: string; usable: boolean }[];
    expect(listed).toContainEqual(
      expect.objectContaining({ id, hash: package_sha256, usable: true }),
    );
    const b = await w.install(draft());
    expect(b.status).toBe(200);
    expect(b.body).toMatchObject({ id, package_sha256 });
  });

  it("refuses a draft whose hidden expected equals the input in every case", async () => {
    const w = await world();
    const d = draft();
    const cat = draft({ hidden: d.hidden.map((p) => ({ ...p, expected: p.input })) });
    const r = await w.install(cat);
    expect(r.status).toBe(422);
    expect(r.body.code).toBe("DRAFT_REJECTED");
    expect((await w.service.packages()).length).toBe(0);
  });

  it.skipIf(!sandboxed)(
    "adopts the new package on P_DEPOSIT by hash; correct delivery PASS, wrong delivery FAIL",
    async () => {
      const w = await world();
      expect(w.vcat.size).toBe(0);
      const { body } = await w.install(draft());
      const hash = body.package_sha256 as string;
      for (const [source, outcome] of [
        [REFERENCE, "PASS"],
        [WRONG, "FAIL"],
      ] as const) {
        const d = await deposit(w, hash);
        expect(d.answer).toMatchObject({ ok: true });
        w.sent.length = 0;
        const verdict = await deliver(w, d.tid, delivery(source));
        expect(verdict, outcome).toBeDefined();
        expect(JSON.stringify(verdict)).toContain(outcome === "PASS" ? "RELEASE" : "WITHHOLD");
      }
    },
    120_000,
  );
});
