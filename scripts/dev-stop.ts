// pnpm dev:stop - frees the dev ports, killing only processes that belong to THIS repo
// (listener or wrapper whose command line or cwd is under this folder). Prints what it killed.
import { execFileSync } from "node:child_process";
import { readFileSync, readlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DEV_PORTS = [7401, 7402, 7403, 7404, 7405, 5173] as const;
export const WALLET_PORTS = [7411, 7412] as const;
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const cmdline = (pid: number): string => {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ").trim();
  } catch {
    return "";
  }
};
const cwd = (pid: number): string => {
  try {
    return readlinkSync(`/proc/${pid}/cwd`);
  } catch {
    return "";
  }
};
const ppid = (pid: number): number => {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
  } catch {
    return 0;
  }
};
const ours = (pid: number) => cmdline(pid).includes(ROOT) || cwd(pid).startsWith(ROOT);

function listenerPids(port: number): number[] {
  let out = "";
  try {
    out = execFileSync("ss", ["-ltnpH", `sport = :${port}`], { encoding: "utf8" });
  } catch {
    return [];
  }
  return [...out.matchAll(/pid=(\d+)/g)].map((m) => Number(m[1]));
}

export async function stopDev(opts: { wallet?: boolean } = {}): Promise<void> {
  const ports: readonly number[] = opts.wallet ? [...DEV_PORTS, ...WALLET_PORTS] : DEV_PORTS;
  if (opts.wallet)
    console.log(
      "[dev:stop] WARNING: stopping the wallet daemons loses the Lightning channels; run pnpm demo:reset afterwards.",
    );
  else
    console.log(
      "[dev:stop] wallet daemons (7411, 7412) left running; use --wallet to stop them too",
    );
  const safe = new Set<number>();
  for (let p = process.pid; p > 1; p = ppid(p)) safe.add(p);
  const targets = new Map<number, string>();
  for (const port of ports) {
    for (const pid of listenerPids(port)) {
      if (safe.has(pid)) continue;
      if (!ours(pid)) {
        console.log(`[dev:stop] port ${port}: pid ${pid} is not from this repo, left alone`);
        continue;
      }
      targets.set(pid, `port ${port}`);
      // wrappers (pnpm, tsx watch, concurrently) of the same repo go too, or they respawn it
      for (let p = ppid(pid); p > 1 && !safe.has(p) && ours(p); p = ppid(p))
        if (/pnpm|tsx|concurrently|vite|node/.test(cmdline(p))) targets.set(p, `wrapper of ${pid}`);
    }
  }
  for (const [pid, why] of targets) {
    console.log(`[dev:stop] killed ${pid} (${why}): ${cmdline(pid).slice(0, 100)}`);
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // already gone
    }
  }
  if (targets.size === 0) console.log("[dev:stop] nothing of this repo was running");
  for (let i = 0; i < 20 && [...targets.keys()].some((p) => cmdline(p) !== ""); i++)
    await new Promise((r) => setTimeout(r, 250));
  for (const pid of targets.keys())
    if (cmdline(pid) !== "")
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // gone
      }
}

if (import.meta.url === `file://${process.argv[1]}`)
  await stopDev({ wallet: process.argv.includes("--wallet") });
