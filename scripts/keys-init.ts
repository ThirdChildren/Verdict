// pnpm keys:init - writes $VERDICT_DATA_DIR/identities.json (public ids) and keys/<role>.key (0600, secrets).
import { dataDir, initIdentities } from "../packages/identity/src/identities.js";

const dir = dataDir();
const r = await initIdentities(dir);
for (const n of r.notes) console.log("[keys]", n);
console.log(`[keys] new keys: ${r.created.join(", ") || "none (kept existing)"}`);
for (const [role, id] of Object.entries(r.identities)) console.log(`[keys] ${role}: ${id}`);
console.log(`[keys] wrote ${dir}/identities.json (public ids only)`);
