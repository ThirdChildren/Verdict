// pnpm data:perms [--fix] - the data dir must be 0700 and every secret file 0600 (L3). Exit 1 if not.
import { auditDataDir, dataDir } from "../packages/wallet/src/index.js";

const dir = dataDir();
const fix = process.argv.includes("--fix");
const problems = auditDataDir(dir, { fix });
for (const p of problems)
  console.error(`[perms] ${p.path}: mode ${p.mode}, want ${p.want}${fix ? " (fixed)" : ""}`);
if (problems.length > 0 && !fix) {
  console.error("[perms] run: pnpm data:perms -- --fix");
  process.exit(1);
}
console.log(`[perms] ${dir} ok`);
