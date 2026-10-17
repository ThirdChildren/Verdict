// P3.3 real e2e: mandate -> child -> intent -> offer -> accept -> P_DEPOSIT/P_CONFIRM -> HODL invoice -> payment -> real 9B
// deliverable -> DELIVER -> sandboxed verifier -> signed verdict -> claim or cancel or silence.
// Needs `pnpm demo:reset` first (fresh regtest, wallet daemons, channel) and the 9B model in the QVAC cache.
// Spawns its own engine (:7491), worker (:7493) and verifier (:7494) with temp state, so it never touches a running dev stack.
// Scenarios run one after the other and share the channel:
//   a) normal -> PASS -> claim -> committed
//   b) sabotaged -> FAIL -> worker cancels -> released
//   c) worker disappears (never delivers) -> WORKER_STATUS stopped, no verifier run -> mine until refund -> released, EXPIRED
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CAP_VERSION,
  capId,
  createEd25519Signer,
  signPayload,
} from "../../packages/protocol/src/index.js";
import {
  dataDir,
  loadIdentities,
  loadNetwork,
  loadSecretSeed,
  WalletClient,
} from "../../packages/wallet/src/index.js";
import { mineUntilFailed } from "../../scripts/demo-expire.js";
import { eip191SignerFromSeed } from "../../services/capability-engine/src/signer.js";
import { extractTarball, runVerification } from "../../services/verifier/src/runner.js";

const ENGINE_PORT = 7491;
const WORKER_PORT = 7493;
const VERIFIER_PORT = 7494;
const ENGINE = `http://127.0.0.1:${ENGINE_PORT}`;
const WORKER = `http://127.0.0.1:${WORKER_PORT}`;
const VERIFIER = `http://127.0.0.1:${VERIFIER_PORT}`;
// LAN mode (VERDICT_E2E_LAN=1, P3.6a): the verifier is bound to this machine's LAN address and reached through it,
// and the engine and worker accept the verifier's messages on their LAN address, as they will with the Mac.
const LAN_IP = process.env.VERDICT_E2E_LAN
  ? (process.env.VERDICT_E2E_LAN_IP ??
    Object.values(networkInterfaces())
      .flat()
      .find((i) => i?.family === "IPv4" && !i.internal)?.address)
  : undefined;
if (process.env.VERDICT_E2E_LAN && !LAN_IP)
  throw new Error("LAN mode needs a LAN IPv4 address (set VERDICT_E2E_LAN_IP)");
const lan = (port: number) => `http://${LAN_IP}:${port}`;
const PACKAGE_DIR = join(import.meta.dirname, "../../verifier-packages/csv2json-v1");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Budget = { cap_id: string; remaining: string; reserved: string; committed: string };
type WorkerTask = {
  taskId: string;
  paymentHash: string;
  state: string;
  reason?: string;
  delivery?: { dir: string; dirHash: string };
  attempts?: { self_check: string }[];
  toggles?: { sabotaged: boolean; disappears: boolean };
};
type VerifierTask = {
  task_id: string;
  released: boolean;
  reports: {
    outcome: "PASS" | "FAIL";
    code: string | null;
    sandbox: string;
    log_tail: string[];
    record: { verdict: string; exit_code: number; checks: { id: string; status: string }[] };
  }[];
};

const procs: ChildProcess[] = [];
let tmp: string;
let workerWallet: WalletClient;
let buyerWallet: WalletClient;
let capHash: string;
let ws: WebSocket;
const budgets: Budget[] = [];
const taskStates = new Map<string, string[]>();
const timings: string[] = [];
const seenTasks = new Set<string>();

async function until<T>(
  f: () => T | undefined | Promise<T | undefined>,
  what: string,
  ms = 90_000,
) {
  for (let t = 0; t < ms; t += 500) {
    const v = await f();
    if (v !== undefined) return v;
    await sleep(500);
  }
  throw new Error(`timeout waiting for ${what}`);
}
const healthy = (url: string) =>
  fetch(url).then(
    (r) => r.ok,
    () => false,
  );
const json = async <T>(url: string): Promise<T> => (await fetch(url)).json() as Promise<T>;
const workerTasks = async () => (await json<{ tasks: WorkerTask[] }>(`${WORKER}/v0/tasks`)).tasks;
const verifierTasks = async () =>
  (await json<{ tasks: VerifierTask[] }>(`${VERIFIER}/v0/verdicts`)).tasks;
const setWorker = (c: { sabotaged?: boolean; disappears?: boolean }) =>
  fetch(`${WORKER}/v0/config`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(c),
  });
const SILENCE_MS = 3000;
const workerStopped = new Map<
  string,
  { worker_status: string; silent_seconds: number; message: string }
>();
const mineRoute = async (taskId: string) => {
  const r = await fetch(`${ENGINE}/api/demo/mine-until-refund`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ task_id: taskId }),
  });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
};
const lastBudget = () => budgets.at(-1);

async function signMandate(): Promise<string> {
  const dir = dataDir();
  const ids = loadIdentities(dir);
  const principal = await eip191SignerFromSeed(loadSecretSeed("principal", dir));
  const base = {
    version: CAP_VERSION,
    issuer: principal.publicId,
    subject: "buyer-agent",
    asset_id: loadNetwork(dir).tusd_asset_id,
    max_total: "10.01",
    max_per_task: "2.00",
    allowed_actions: ["task_payment"],
    allowed_categories: ["code"],
    counterparties: "preapproved_workers",
    allowed_payees: [ids.worker],
    recurring: false,
    expires_at: new Date(Date.now() + 3 * 3600_000).toISOString().replace(/\.\d{3}Z$/, "Z"),
    parent: null,
  };
  const withId = { ...base, cap_id: capId(base) };
  const root = { ...withId, signature: await signPayload(principal, "CAP_ROOT", withId) };
  const r = await fetch(`${ENGINE}/api/mandate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ root }),
  });
  const j = (await r.json()) as { ok: boolean; cap_hash: string };
  if (!j.ok) throw new Error(`mandate refused: ${JSON.stringify(j)}`);
  return j.cap_hash;
}

/** The buyer agent's act: a spend intent signed by the child holder (the buyer key). */
async function sendIntent(amount: string, rationale: string) {
  const dir = dataDir();
  const ids = loadIdentities(dir);
  const buyer = await createEd25519Signer(loadSecretSeed("buyer", dir));
  const body = {
    cap_hash: capHash,
    intent: {
      kind: "task_payment",
      category: "code",
      counterparty: ids.worker,
      amount,
      recurring: false,
      interval: null,
      task_spec:
        "Write csv2json.mjs: a zero-dependency Node ESM CLI that converts a CSV file (quoted fields, CRLF, UTF-8) to a JSON array of objects.",
      deadline: new Date(Date.now() + 25 * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z"),
      rationale,
    },
  };
  const env: Record<string, unknown> = {
    v: 0,
    id: crypto.randomUUID(),
    task_id: "task_0000000000000000",
    from: buyer.publicId,
    to: ids.engine,
    sent_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    type: "SPEND_INTENT",
    body,
  };
  env.sig = await signPayload(buyer, "SPEND_INTENT", env);
  const r = await fetch(`${ENGINE}/v0/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(env),
  });
  expect(r.status).toBe(200);
}

/** Runs one intent and returns the worker's task for it. */
async function startTask(amount: string, rationale: string): Promise<WorkerTask> {
  // A child capability allows one payment, so every task gets its own mandate.
  capHash = await signMandate();
  await sendIntent(amount, rationale);
  const t = await until(
    async () => (await workerTasks()).find((x) => !seenTasks.has(x.taskId)),
    "the worker to receive the offer",
    60_000,
  );
  seenTasks.add(t.taskId);
  return t;
}
const worker = async (id: string) => (await workerTasks()).find((t) => t.taskId === id);
const verifierOf = async (id: string) => (await verifierTasks()).find((t) => t.task_id === id);
const states = (id: string) => taskStates.get(id) ?? [];

const timed = async <T>(name: string, f: () => Promise<T>): Promise<T> => {
  const t0 = Date.now();
  try {
    return await f();
  } finally {
    const line = `scenario ${name}: ${((Date.now() - t0) / 1000).toFixed(1)} s`;
    timings.push(line);
    console.log(`[e2e] ${line}`);
  }
};

function spawnService(filter: string, env: Record<string, string>): ChildProcess {
  return spawn("pnpm", ["--filter", filter, "start"], {
    env: { ...process.env, ...env },
    stdio: "ignore",
    detached: true,
  });
}

beforeAll(async () => {
  workerWallet = new WalletClient({
    baseUrl: process.env.WORKER_WALLET_URL ?? "http://127.0.0.1:7412",
  });
  buyerWallet = new WalletClient({
    baseUrl: process.env.WALLET_BUYER_URL ?? "http://127.0.0.1:7411",
  });
  await Promise.all([workerWallet.init(), buyerWallet.init()]).catch(() => {
    throw new Error("Wallet daemons are not running. Run: pnpm demo:reset");
  });
  for (const [name, url] of [
    ["engine", ENGINE],
    ["worker", WORKER],
    ["verifier", VERIFIER],
  ] as const)
    if (await healthy(`${url}/health`))
      throw new Error(`the ${name} port is already in use by a stale process`);
  tmp = mkdtempSync(join(tmpdir(), "escrow-e2e-"));
  procs.push(
    spawnService("@verdict/capability-engine", {
      ENGINE_PORT: String(ENGINE_PORT),
      ENGINE_LEDGER_PATH: join(tmp, "ledger.sqlite"),
      VERDICT_WALLET: "1",
      VERDICT_DEMO_TOGGLES: "1",
      VERDICT_WORKER_SILENCE_MS: String(SILENCE_MS),
      WORKER_URL: WORKER,
      VERIFIER_URL: LAN_IP ? lan(VERIFIER_PORT) : VERIFIER,
      ...(LAN_IP ? { VERDICT_LAN_BIND: LAN_IP } : {}),
    }),
    spawnService("@verdict/worker", {
      WORKER_PORT: String(WORKER_PORT),
      ENGINE_URL: ENGINE,
      VERDICT_DEMO_TOGGLES: "1",
      ...(LAN_IP ? { VERDICT_LAN_BIND: LAN_IP } : {}),
    }),
    spawnService("@verdict/verifier", {
      VERIFIER_PORT: String(VERIFIER_PORT),
      ENGINE_URL: LAN_IP ? lan(ENGINE_PORT) : ENGINE,
      WORKER_URL: LAN_IP ? lan(WORKER_PORT) : WORKER,
      ...(LAN_IP ? { VERDICT_LAN_BIND: LAN_IP } : {}),
      VERIFIER_REGISTRY: join(tmp, "verifier-registry.json"),
    }),
  );
  await until(
    async () =>
      (await healthy(`${ENGINE}/health`)) && (await healthy(`${VERIFIER}/health`))
        ? true
        : undefined,
    "engine and verifier",
    120_000,
  );
  await until(
    async () => ((await healthy(`${WORKER}/health`)) ? true : undefined),
    "worker model load",
    240_000,
  );
  ws = new WebSocket(`ws://127.0.0.1:${ENGINE_PORT}/v0/events`);
  ws.onmessage = (m) => {
    const e = JSON.parse(String(m.data)) as { type: string; data: Record<string, unknown> };
    if (e.type === "BUDGET_UPDATED") budgets.push(e.data as unknown as Budget);
    if (e.type === "WORKER_STATUS" && e.data.worker_status === "stopped")
      workerStopped.set(
        String(e.data.task_id),
        e.data as unknown as { worker_status: string; silent_seconds: number; message: string },
      );
    if (e.type === "TASK_STATE") {
      const id = String(e.data.task_id);
      taskStates.set(id, [...(taskStates.get(id) ?? []), String(e.data.state)]);
    }
  };
  await new Promise((r) => {
    ws.onopen = r;
  });
}, 450_000);

afterAll(async () => {
  console.log(`[e2e] timings: ${timings.join(" | ")}`);
  ws?.close();
  // pnpm wraps node, so signal the whole process group or the services outlive the test.
  for (const p of procs)
    try {
      if (p.pid) process.kill(-p.pid, "SIGTERM");
    } catch {
      // already gone
    }
  await Promise.all([workerWallet?.close(), buyerWallet?.close()]);
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe("P3.3 escrow with verifier on real regtest", () => {
  let goodDelivery: string | undefined;

  it("a) normal: PASS -> the worker claims with P -> committed", async () => {
    await timed("a normal", async () => {
      const t = await startTask("1.00", "e2e P3.3 a");
      await until(
        () => (lastBudget()?.reserved === "1.00" ? true : undefined),
        "reserved 1.00",
        120_000,
      );
      const done = await until(
        async () => {
          const w = await worker(t.taskId);
          return w?.state === "CLAIMED" ? w : undefined;
        },
        "the worker to claim",
        500_000,
      );
      goodDelivery = done.delivery?.dir;
      const v = await until(
        async () => (await verifierOf(t.taskId))?.reports[0],
        "the verifier report",
        30_000,
      );
      expect(v).toMatchObject({ outcome: "PASS" });
      expect(v.record).toMatchObject({ verdict: "RELEASE", exit_code: 0 });
      expect(v.sandbox).not.toBe("none");
      const b = await until(
        () =>
          lastBudget()?.committed === "1.00" && lastBudget()?.reserved === "0.00"
            ? lastBudget()
            : undefined,
        "committed 1.00",
        60_000,
      );
      expect(b).toMatchObject({ reserved: "0.00", committed: "1.00" });
      await until(
        () => (states(t.taskId).at(-1) === "CLAIMED" ? true : undefined),
        "task CLAIMED",
        30_000,
      ).catch((e) => {
        throw new Error(`${e.message}; states seen: ${states(t.taskId).join(",")}`);
      });
      expect(states(t.taskId)).toEqual([
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
    });
  });

  it("b) sabotaged: FAIL -> the worker cancels -> released", async () => {
    await timed("b sabotaged", async () => {
      await setWorker({ sabotaged: true });
      const t = await startTask("1.00", "e2e P3.3 b");
      const w = await until(
        async () => {
          const x = await worker(t.taskId);
          return x?.state === "CANCELLED" ? x : undefined;
        },
        "the worker to cancel",
        300_000,
      );
      expect(w.delivery?.dir).toBeTruthy();
      const v = await until(
        async () => (await verifierOf(t.taskId))?.reports[0],
        "the verifier report",
        30_000,
      );
      expect(v).toMatchObject({ outcome: "FAIL" });
      expect(v.record).toMatchObject({ verdict: "WITHHOLD", exit_code: 1 });
      expect(v.record.checks.find((c) => c.id === "tests")?.status).toBe("FAIL");
      expect((await verifierOf(t.taskId))?.released).toBe(false);
      const b = await until(
        () => (lastBudget()?.reserved === "0.00" ? lastBudget() : undefined),
        "released",
        60_000,
      );
      expect(b).toMatchObject({ reserved: "0.00", committed: "0.00" });
      await until(
        () => (states(t.taskId).at(-1) === "REFUNDED" ? true : undefined),
        "task REFUNDED",
        30_000,
      );
      expect(states(t.taskId).slice(-5)).toEqual([
        "ESCROW_LOCKED",
        "DELIVERED",
        "VERDICT_WITHHOLD",
        "EXPIRED",
        "REFUNDED",
      ]);
    });
  });

  it("c) the worker disappears: locked, WORKER_STATUS stopped, no verifier run, mine -> refunded", async () => {
    await timed("c disappears", async () => {
      await setWorker({ sabotaged: false, disappears: true });
      const t = await startTask("1.00", "e2e P3.3 c");
      await until(
        () => (lastBudget()?.reserved === "1.00" ? true : undefined),
        "reserved 1.00",
        120_000,
      );
      await until(
        () => (states(t.taskId).includes("ESCROW_LOCKED") ? true : undefined),
        "ESCROW_LOCKED",
        120_000,
      );
      const stopped = await until(
        () => workerStopped.get(t.taskId),
        "WORKER_STATUS stopped",
        SILENCE_MS + 60_000,
      );
      expect(stopped.worker_status).toBe("stopped");
      expect(stopped.silent_seconds).toBeGreaterThanOrEqual(0);
      expect(typeof stopped.message).toBe("string");
      // The worker never works, delivers, claims or cancels; the verifier never runs; P stays put.
      await sleep(3000);
      const w = (await worker(t.taskId)) as WorkerTask;
      expect(w.delivery).toBeUndefined();
      const v = await verifierOf(t.taskId);
      expect(v?.reports ?? []).toHaveLength(0);
      expect(v?.released ?? false).toBe(false);
      expect(lastBudget()).toMatchObject({ reserved: "1.00", committed: "0.00" });
      expect(states(t.taskId).at(-1)).toBe("ESCROW_LOCKED");
      const buyerSide = await buyerWallet.paymentStatus(w.paymentHash);
      expect(buyerSide.some((e) => e.role === "payer" && e.status === "Pending")).toBe(true);
      // Mine until refund (the same route the demo button calls).
      const r = await mineRoute(t.taskId);
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ ok: true, refunded: true });
      await until(
        () => (lastBudget()?.reserved === "0.00" ? true : undefined),
        "released after the timeout",
        60_000,
      );
      expect(lastBudget()).toMatchObject({ reserved: "0.00", committed: "0.00" });
      const after = await buyerWallet.paymentStatus(w.paymentHash);
      expect(after.some((e) => e.role === "payer" && e.status === "Failed")).toBe(true);
      await until(
        () => (states(t.taskId).at(-1) === "REFUNDED" ? true : undefined),
        "task REFUNDED",
        30_000,
      );
      expect(states(t.taskId)).toContain("EXPIRED");
      expect((await verifierOf(t.taskId))?.released ?? false).toBe(false);
    });
  });

  it("c2) mine until refund is refused while another payment is in flight", async () => {
    await timed("c2 refusal", async () => {
      await setWorker({ sabotaged: false, disappears: true });
      const t1 = await startTask("1.00", "e2e P3.3 c2 first");
      await until(
        () => (states(t1.taskId).includes("ESCROW_LOCKED") ? true : undefined),
        "first ESCROW_LOCKED",
        120_000,
      );
      const t2 = await startTask("1.00", "e2e P3.3 c2 second");
      await until(
        () => (states(t2.taskId).includes("ESCROW_LOCKED") ? true : undefined),
        "second ESCROW_LOCKED",
        120_000,
      );
      const r = await mineRoute(t2.taskId);
      expect(r.status).toBe(409);
      expect(r.body).toMatchObject({ ok: false, code: "DEMO_OTHER_PAYMENT_IN_FLIGHT" });
      expect(states(t2.taskId).at(-1)).toBe("ESCROW_LOCKED");
      // Clean up: mine past both HTLC expiries directly so later scenarios start clean.
      for (const t of [t1, t2]) {
        const w = (await worker(t.taskId)) as WorkerTask;
        const m = await mineUntilFailed(buyerWallet, w.paymentHash, {
          log: (x) => console.log(`[e2e] ${x}`),
        });
        expect(m.failed).toBe(true);
      }
      await until(
        () => (lastBudget()?.reserved === "0.00" ? true : undefined),
        "both released",
        60_000,
      );
      await setWorker({ sabotaged: false, disappears: false });
    });
  });

  it("d) toggles apply live: on -> FAIL, off -> PASS, no restart and no reload between", async () => {
    await timed("d live toggles", async () => {
      const on = await setWorker({ sabotaged: true });
      expect(await on.json()).toMatchObject({ sabotaged: true });
      const t1 = await startTask("1.00", "e2e P4.1 d1");
      const w1 = await until(
        async () => {
          const x = await worker(t1.taskId);
          return x?.state === "CANCELLED" ? x : undefined;
        },
        "the sabotaged task to be cancelled",
        300_000,
      );
      expect(w1.toggles).toEqual({ sabotaged: true, disappears: false });
      const off = await setWorker({ sabotaged: false });
      expect(await off.json()).toMatchObject({ sabotaged: false });
      const t2 = await startTask("1.00", "e2e P4.1 d2");
      const w2 = await until(
        async () => {
          const x = await worker(t2.taskId);
          return x?.state === "CLAIMED" ? x : undefined;
        },
        "the normal task to be claimed",
        500_000,
      );
      expect(w2.toggles).toEqual({ sabotaged: false, disappears: false });
    });
  });

  it.skipIf(!LAN_IP)(
    "LAN surface: only signed POST /v0/messages is reachable at the LAN address",
    async () => {
      const get = (u: string) =>
        fetch(u, { signal: AbortSignal.timeout(5000) }).then((r) => r.status);
      const post = (u: string) =>
        fetch(`${u}/v0/messages`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
          signal: AbortSignal.timeout(5000),
        }).then((r) => r.status);
      for (const [name, url] of [
        ["verifier", lan(VERIFIER_PORT)],
        ["engine", lan(ENGINE_PORT)],
        ["worker", lan(WORKER_PORT)],
      ] as const) {
        expect(await post(url), `${name} messages`).toBe(400); // reached the handler; the empty body is refused
        expect(await get(`${url}/health`), `${name} health`).toBe(403);
      }
      expect(await get(`${lan(ENGINE_PORT)}/api/mandate/active`)).toBe(403);
      expect(await get(`${lan(VERIFIER_PORT)}/v0/verdicts`)).toBe(403);
    },
  );

  it("verify.sh run twice on the same real delivery gives the same verdict", async () => {
    expect(goodDelivery, "scenario a must have run").toBeTruthy();
    const run = async () => {
      const tar = join(tmp, "good.tar.gz");
      spawnSync("tar", ["-czf", tar, "-C", goodDelivery as string, "."]);
      const dest = join(tmp, `rerun-${Math.random().toString(16).slice(2)}`);
      spawnSync("mkdir", ["-p", dest]);
      extractTarball(tar, dest);
      return runVerification({ packageDir: PACKAGE_DIR, deliveryDir: dest, maxVerifySeconds: 60 });
    };
    const [x, y] = [await run(), await run()];
    expect(x.outcome).toBe("PASS");
    expect({ ...y, message: "" }).toEqual({ ...x, message: "" });
  });
});
