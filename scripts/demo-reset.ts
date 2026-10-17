// demo:reset = stop daemons, regtest reset, setup from scratch (fresh seeds, funding, tUSD), start both wallet
// daemons, open the channel through them (ADR-023: channels do not survive restarts). Prints the duration.
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "../packages/wallet/src/index.js";
import { openChannel, startDaemons, stopDaemons } from "./wallet-daemons.js";

const t0 = Date.now();
const phase = (name: string, since: number) =>
  console.log(`[demo:reset] ${name} done in ${((Date.now() - since) / 1000).toFixed(1)} s`);

/** The old ledger would hold reservations for a regtest that no longer exists: archive it, never delete it. */
function archiveLedger(): void {
  const dir = dataDir();
  const live = join(dir, "engine-ledger.sqlite");
  if (!existsSync(live)) return;
  const archive = join(dir, "ledger-archive");
  mkdirSync(archive, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  for (const suffix of ["", "-wal", "-shm"])
    if (existsSync(live + suffix))
      renameSync(live + suffix, join(archive, `${stamp}.sqlite${suffix}`));
  console.log(`[demo:reset] ledger archived to ${archive}/${stamp}.sqlite`);
}
/** Tasks the verifier remembers belong to the old regtest too. */
function archiveVerifierRegistry(): void {
  const file = join(dataDir(), "verifier", "registry.json");
  if (!existsSync(file)) return;
  const archive = join(dataDir(), "ledger-archive");
  mkdirSync(archive, { recursive: true });
  renameSync(
    file,
    join(archive, `${new Date().toISOString().replace(/[:.]/g, "-")}.verifier-registry.json`),
  );
}
const sh = (cmd: string) => execSync(cmd, { stdio: "inherit", timeout: 1_800_000 });

try {
  let t = Date.now();
  await stopDaemons();
  archiveLedger();
  archiveVerifierRegistry();
  sh("bash scripts/regtest.sh reset");
  phase("regtest reset", t);
  t = Date.now();
  sh("bash scripts/regtest.sh setup -- --step seeds,fund,tusd");
  phase("seeds, funding, tUSD", t);
  t = Date.now();
  await startDaemons();
  await openChannel();
  phase("daemons + channel", t);
} catch (e) {
  console.error(`[demo:reset] FAILED: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
console.log(`[demo:reset] OK, total ${((Date.now() - t0) / 1000).toFixed(1)} s`);
process.exit(0);
