import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";

/** Shared by `pnpm demo:expire` and the engine's gated "mine until refund" route. No secrets pass through here. */
export const MAX_BLOCKS = 200;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const execFileP = promisify(execFile);

export interface ExpireResult {
  failed: boolean;
  blocks: number;
  seconds: number;
}

/** Mines one block on regtest through scripts/regtest.sh (blocking; used by the CLI). */
export const mineOneBlockSync = (): void => {
  execFileSync("bash", ["scripts/regtest.sh", "mine", "1"], { stdio: "ignore" });
};

/** Same, non-blocking, for the engine process. `repoRoot` is the working directory that holds scripts/. */
export const mineOneBlockAsync = (repoRoot: string) => async (): Promise<void> => {
  await execFileP("bash", ["scripts/regtest.sh", "mine", "1"], { cwd: repoRoot });
};

/** Mines one block at a time (a lock is 45 to 150 blocks, measured in P0.3) until the payer side says Failed. */
export async function mineUntilFailed(
  wallet: { paymentStatus(h: string): Promise<{ role: string; status: string }[]> },
  paymentHash: string,
  opts: {
    mine?: () => unknown;
    cap?: number;
    pauseMs?: number;
    log?: (msg: string) => void;
    /** Called after every check with the number of blocks mined so far. */
    onProgress?: (blocks: number) => unknown;
  } = {},
): Promise<ExpireResult> {
  const mine = opts.mine ?? mineOneBlockSync;
  const cap = opts.cap ?? MAX_BLOCKS;
  const t0 = Date.now();
  const secs = () => Number(((Date.now() - t0) / 1000).toFixed(1));
  for (let blocks = 0; blocks <= cap; blocks++) {
    const seen = await wallet.paymentStatus(paymentHash).catch(() => []);
    await opts.onProgress?.(blocks);
    if (seen.some((e) => e.role === "payer" && e.status === "Failed"))
      return { failed: true, blocks, seconds: secs() };
    if (blocks === cap) break;
    await mine();
    if (blocks > 0 && blocks % 10 === 0) opts.log?.(`mined ${blocks} blocks, still held`);
    await sleep(opts.pauseMs ?? 400);
  }
  return { failed: false, blocks: cap, seconds: secs() };
}
