// Start/stop the two long-lived wallet daemons (buyer, worker) and open the tUSD channel through them.
//   tsx scripts/wallet-daemons.ts start | stop | status
// The channel lives only as long as the daemons do (ADR-023): never restart one without `pnpm demo:reset`.
import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveDataDir } from "../packages/identity/src/data-dir.js";
import { WalletClient } from "../packages/wallet/src/index.js";

const DATA = resolveDataDir();
const RUN = join(DATA, "daemons");
// Daemon output goes to the repo-local, gitignored ./.logs (pino redacts secrets), never under the data dir.
const LOGS = join(import.meta.dirname, "..", ".logs");
const SHARED = join(DATA, "regtest", "shared");
const ROOT = join(import.meta.dirname, "..");
export const ROLES = ["worker", "buyer"] as const; // worker first: the buyer connects to it
export const URLS = { buyer: "http://127.0.0.1:7411", worker: "http://127.0.0.1:7412" } as const;
const LN_PORT = { buyer: 9801, worker: 9802 } as const;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (...a: unknown[]) => console.log("[daemons]", ...a);
const pidFile = (r: string) => join(RUN, `${r}.pid`);
const mine = (n: number) => {
  const p = spawn("bash", [join(ROOT, "scripts/regtest.sh"), "mine", String(n)], {
    stdio: "ignore",
  });
  return new Promise<void>((res, rej) =>
    p.on("exit", (c) => (c === 0 ? res() : rej(new Error(`mine exited with ${c}`)))),
  );
};

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
const readPid = (r: string): number | undefined =>
  existsSync(pidFile(r)) ? Number(readFileSync(pidFile(r), "utf8")) : undefined;

export async function stopDaemons(): Promise<void> {
  for (const role of [...ROLES].reverse()) {
    const pid = readPid(role);
    if (pid && alive(pid)) {
      process.kill(pid, "SIGTERM");
      for (let i = 0; i < 60 && alive(pid); i++) await sleep(250);
      if (alive(pid)) {
        log(`${role} did not stop in 15 s, killing`);
        process.kill(pid, "SIGKILL");
      }
    }
    rmSync(pidFile(role), { force: true });
  }
}

export async function startDaemons(): Promise<void> {
  mkdirSync(RUN, { recursive: true, mode: 0o700 });
  for (const role of ROLES) {
    mkdirSync(LOGS, { recursive: true });
    const out = openSync(join(LOGS, `daemon-${role}.log`), "a");
    const child = spawn(
      process.execPath,
      ["--import", "tsx", join(ROOT, "apps/wallet-daemon/src/main.ts"), role],
      { cwd: ROOT, detached: true, stdio: ["ignore", out, out], env: process.env },
    );
    child.unref();
    closeSync(out);
    writeFileSync(pidFile(role), String(child.pid));
    const client = new WalletClient({ baseUrl: URLS[role], timeoutMs: 2_000 });
    let up = false;
    for (let i = 0; i < 240 && !up; i++) {
      if (child.exitCode !== null)
        throw new Error(`${role} daemon exited; see .logs/daemon-${role}.log`);
      try {
        await client.init();
        up = true;
      } catch {
        await sleep(500);
      }
    }
    if (!up)
      throw new Error(`${role} daemon not healthy after 120 s; see .logs/daemon-${role}.log`);
    log(`${role} daemon up (pid ${child.pid}, ${URLS[role]})`);
  }
}

/** Buyer daemon opens a tUSD channel to the worker daemon; resolves when the channel is usable. */
export async function openChannel(): Promise<void> {
  const assetId = (
    JSON.parse(readFileSync(join(SHARED, "asset.json"), "utf8")) as { assetId: string }
  ).assetId;
  const buyer = new WalletClient({ baseUrl: URLS.buyer });
  const worker = new WalletClient({ baseUrl: URLS.worker });
  const workerNodeId = await worker.nodeId();
  await buyer.openRgbChannel({
    peer: `${workerNodeId}@127.0.0.1:${LN_PORT.worker}`,
    assetId,
    assetAmount: 50_000n,
    capacitySat: 100_000,
  });
  await mine(6);
  for (let i = 0; ; i++) {
    await mine(1);
    await sleep(2500);
    const r = await fetch(`${URLS.buyer}/v0/admin/channels`, {
      signal: AbortSignal.timeout(15_000),
    });
    const { channels } = (await r.json()) as {
      channels: Array<{ ready?: boolean; is_usable?: boolean }>;
    };
    if (channels[0]?.ready && channels[0]?.is_usable) break;
    if (i >= 40) throw new Error("channel did not become usable");
  }
  writeFileSync(
    join(SHARED, "setup.json"),
    JSON.stringify({
      assetId,
      precision: 2,
      buyerUrl: URLS.buyer,
      workerUrl: URLS.worker,
      workerNodeId,
    }),
  );
  log("channel usable; buyer outbound", (await buyer.assetBalance(assetId)).offchainOutbound);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cmd = process.argv[2];
  if (cmd === "start") await startDaemons();
  else if (cmd === "stop") await stopDaemons();
  else if (cmd === "status")
    for (const r of ROLES) {
      const pid = readPid(r);
      log(r, pid && alive(pid) ? `running (pid ${pid})` : "stopped");
    }
  else {
    console.error("usage: wallet-daemons.ts start|stop|status");
    process.exit(2);
  }
  process.exit(0);
}
