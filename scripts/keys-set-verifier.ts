// pnpm keys:set-verifier -- <ed25519:...>   Legion: records the Mac verifier's public id in identities.json.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir, loadIdentities } from "../packages/identity/src/index.js";

const id = process.argv.slice(2).find((a) => a !== "--");
if (!id || !/^ed25519:[0-9a-f]{64}$/.test(id)) {
  console.error(
    "Usage: pnpm keys:set-verifier -- ed25519:<64 hex>   (the id printed by `pnpm verifier:keys` on the Mac)",
  );
  process.exit(1);
}
const dir = dataDir();
loadIdentities(dir); // fails with a plain message if keys:init was never run
const file = join(dir, "identities.json");
const all = JSON.parse(readFileSync(file, "utf8")) as Record<string, string>;
const old = all.verifier;
all.verifier = id;
writeFileSync(file, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o644 });
console.log(`[keys] verifier ${old} -> ${id}`);
console.log(
  `[keys] now copy ${file} to the Mac's data dir (public ids only) and restart the engine and worker.`,
);
