// Regtest setup, in phases: seeds -> fund -> tusd. The channel is opened by the wallet daemons (`pnpm demo:reset`, ADR-023). Run all: `pnpm regtest:setup`; one phase alone:
// `pnpm regtest:setup -- --step <seeds|fund|tusd>` (comma list allowed: seeds,fund,tusd).
// $VERDICT_DATA_DIR/regtest/shared, which `regtest:reset` wipes) and prints "FAILED phase <name>" on error.
// Stack must be up. Per-phase timeout: SETUP_STEP_TIMEOUT_MS (default 600000). Needs @utexo/wdk-rgb-lightning installed.
// Writes $VERDICT_DATA_DIR/regtest/shared/{buyer,worker}.seed (0600), asset.json, setup.json. Never prints seeds.
import { execSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveDataDir } from "../../packages/identity/src/data-dir.js";
import { createRlnAccount, rlnConfigFromEnv } from "../../packages/wallet/src/index.js";

const DATA = resolveDataDir();
const BASE = join(DATA, "regtest");
const SHARED = join(BASE, "shared");
const RLN = process.env.RLN_COMPOSE_DIR ?? join(BASE, "rln");
const OVERRIDE = join(import.meta.dirname, "compose.override.yaml");
const NODE22 =
  process.env.ISSUER_NODE ??
  join(homedir(), ".local/share/fnm/node-versions/v22.23.3/installation/bin/node");
const PORTS = { buyer: 9801, worker: 9802 } as const;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (...a: unknown[]) => console.log("[setup]", ...a);
const btc = (c: string) =>
  execSync(
    `docker compose -f compose.yaml -f ${OVERRIDE} exec -T -u blits bitcoind bitcoin-cli -regtest ${c}`,
    { cwd: RLN, encoding: "utf8", timeout: 60_000 },
  ).trim();
const mine = (n: number) => btc(`-rpcwallet=miner -generate ${n}`);
const num = (x: unknown, k: string): number => Number((x as Record<string, unknown>)[k] ?? 0);

async function waitFile(p: string, ms = 120_000) {
  for (let t = 0; t < ms; t += 300) {
    if (existsSync(p)) return;
    await sleep(300);
  }
  throw new Error(`timeout waiting for ${p}`);
}

const STEPS = ["seeds", "fund", "tusd"] as const;
type Step = (typeof STEPS)[number];
const argv = process.argv.slice(2).filter((a) => a !== "--");
const si = argv.indexOf("--step");
const wanted = si >= 0 ? (argv[si + 1] ?? "").split(",") : undefined; // --step seeds,fund,tusd
for (const w of wanted ?? []) {
  if (!(STEPS as readonly string[]).includes(w)) {
    console.error(`[setup] unknown step "${w}". Use one of: ${STEPS.join(", ")} (comma-separated)`);
    process.exit(2);
  }
}
const STEP_TIMEOUT = Number(process.env.SETUP_STEP_TIMEOUT_MS ?? 600_000);
const flag = (n: string) => join(SHARED, n);

mkdirSync(SHARED, { recursive: true, mode: 0o700 });
const runIssuer = (mode: "seeds" | "issue") =>
  spawn(NODE22, [join(import.meta.dirname, "issuer/issuer.mjs")], {
    env: {
      ...process.env,
      ISSUER_BASE: BASE,
      RLN_COMPOSE_DIR: RLN,
      COMPOSE_OVERRIDE: OVERRIDE,
      ISSUER_MODE: mode,
    },
    stdio: ["ignore", "ignore", "inherit"],
  });

const readSeeds = () => {
  for (const n of ["buyer", "worker"]) {
    if (!existsSync(flag(`${n}.seed`))) throw new Error("no seeds yet; run --step seeds first");
    chmodSync(flag(`${n}.seed`), 0o600);
  }
  return {
    buyer: readFileSync(flag("buyer.seed"), "utf8").trim(),
    worker: readFileSync(flag("worker.seed"), "utf8").trim(),
  };
};
type Acct = Record<string, (...a: unknown[]) => Promise<unknown>>;
async function openNodes() {
  const seeds = readSeeds();
  const open = (n: "buyer" | "worker") =>
    createRlnAccount(rlnConfigFromEnv(seeds[n], join(BASE, "nodes", n), PORTS[n], n));
  const B = await open("buyer");
  const W = await open("worker");
  log("both nodes unlocked");
  return {
    B,
    W,
    b: B.account as unknown as Acct,
    w: W.account as unknown as Acct,
    close: () => {
      B.dispose();
      W.dispose();
    },
  };
}

async function stepSeeds() {
  if (existsSync(flag("buyer.seed")) && existsSync(flag("worker.seed"))) {
    log("seeds: already present, kept");
    return;
  }
  const p = runIssuer("seeds");
  const code = await new Promise<number | null>((r) => p.on("exit", r));
  if (code !== 0) throw new Error(`seed generation exited with ${code}`);
  log("seeds: created (not printed)");
}

async function stepFund() {
  if (existsSync(flag("funded.flag"))) return log("fund: already done");
  const n = await openNodes();
  try {
    for (const [name, a] of [
      ["buyer", n.b],
      ["worker", n.w],
    ] as const) {
      const addr = (await a.getAddress?.()) as string;
      btc(`-rpcwallet=miner sendtoaddress ${addr} 1`);
      log(name, "funded 1 BTC");
    }
    mine(1);
    await sleep(2000);
    for (const a of [n.b, n.w]) {
      await a.sync?.();
      await a.createUtxos?.({ up_to: false, num: 4, size: 32000, fee_rate: 2, skip_sync: false });
    }
    mine(1);
    await sleep(2000);
    await n.b.sync?.();
    await n.w.sync?.();
    writeFileSync(flag("funded.flag"), "1");
  } finally {
    n.close();
  }
}

function writeNetwork(assetId: string) {
  // reset_epoch marks the start of this regtest world: kept while the asset is unchanged, new after a reset.
  let epoch = new Date().toISOString();
  try {
    const prev = JSON.parse(readFileSync(join(DATA, "network.json"), "utf8")) as Record<
      string,
      unknown
    >;
    if (prev.tusd_asset_id === assetId && typeof prev.reset_epoch === "string")
      epoch = prev.reset_epoch;
  } catch {
    // first write
  }
  const facts = {
    network: "regtest",
    tusd_asset_id: assetId,
    tusd_precision: 2,
    reset_epoch: epoch,
    written_at: new Date().toISOString(),
    // The official regtest compose uses rpcauth user/password; env overrides for a custom stack.
    bitcoind_rpc: {
      url: process.env.BITCOIND_RPC_URL ?? "http://127.0.0.1:18443",
      user: process.env.BITCOIND_RPC_USER ?? "user",
      password: process.env.BITCOIND_RPC_PASSWORD ?? "password",
    },
  };
  const file = join(DATA, "network.json");
  writeFileSync(file, `${JSON.stringify(facts, null, 2)}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
}

async function stepTusd() {
  if (existsSync(flag("done.flag")) && existsSync(flag("asset.json"))) {
    writeNetwork(
      (JSON.parse(readFileSync(flag("asset.json"), "utf8")) as { assetId: string }).assetId,
    );
    return log("tusd: already received");
  }
  if (!existsSync(flag("funded.flag")))
    throw new Error("buyer has no UTXOs; run --step fund first");
  const n = await openNodes();
  const issuer = runIssuer("issue");
  try {
    await waitFile(flag("asset.json"));
    const assetId = (JSON.parse(readFileSync(flag("asset.json"), "utf8")) as { assetId: string })
      .assetId;
    // do NOT pass asset_id here (NotFound: Unknown RGB contract ID, P0.3)
    const rinv = (await n.b.createRgbInvoice?.({
      min_confirmations: 1,
      witness: false,
      duration_seconds: 3600,
    })) as { invoice: string };
    writeFileSync(flag("invoice.txt"), rinv.invoice);
    await waitFile(flag("sent.flag"));
    let got = false;
    for (let i = 0; i < 30 && !got; i++) {
      await n.b.refreshTransfers?.({ skip_sync: false });
      got = num(await n.b.getAssetBalance?.(assetId), "settled") >= 60000;
      if (!got) {
        mine(1);
        await sleep(2500);
      }
    }
    if (!got) throw new Error("buyer never received the tUSD transfer");
    writeFileSync(flag("done.flag"), "1");
    writeNetwork(assetId);
    log("tUSD received by buyer", assetId);
  } finally {
    issuer.kill();
    n.close();
  }
}

const IMPL: Record<Step, () => Promise<void>> = {
  seeds: stepSeeds,
  fund: stepFund,
  tusd: stepTusd,
};

for (const name of (wanted as Step[] | undefined) ?? STEPS) {
  log(`phase ${name}: start`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      IMPL[name](),
      new Promise<never>((_, rej) => {
        timer = setTimeout(() => rej(new Error(`timeout after ${STEP_TIMEOUT} ms`)), STEP_TIMEOUT);
      }),
    ]);
    log(`phase ${name}: ok`);
  } catch (e) {
    console.error(`[setup] FAILED phase ${name}: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  } finally {
    clearTimeout(timer);
  }
}
process.exit(0);
