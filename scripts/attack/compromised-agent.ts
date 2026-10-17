// pnpm attack:compromised - signs a spend intent with the buyer key to an unapproved payee and posts it
// straight to the engine. Expected: COUNTERPARTY_NOT_ALLOWED. Same code the demo-ui button runs.

import { resolveDataDir } from "../../packages/identity/src/data-dir.js";
import { createEd25519Signer } from "../../packages/protocol/src/index.js";
import { type ActiveCap, compromisedAgentAttempt } from "../../services/buyer-agent/src/attack.js";
import { EngineClient } from "../../services/buyer-agent/src/engine-client.js";
import { loadBuyerSeed, loadIdentities } from "../../services/buyer-agent/src/identities.js";

const dataDir = resolveDataDir();
const engineUrl = process.env.ENGINE_URL ?? "http://127.0.0.1:7401";
const ids = loadIdentities(dataDir);
const engine = new EngineClient({
  baseUrl: engineUrl,
  engineId: ids.engine,
  signer: await createEd25519Signer(loadBuyerSeed(dataDir)),
});
const getActiveCap = async (): Promise<ActiveCap | null> => {
  const r = await fetch(`${engineUrl}/api/mandate/active`).catch(() => null);
  const j = (await r?.json().catch(() => null)) as Partial<ActiveCap> | null;
  return r?.ok && j?.cap_hash && j.expires_at && j.remaining && j.allowed_categories
    ? (j as ActiveCap)
    : null;
};
const d = await compromisedAgentAttempt({ engine, getActiveCap });
console.log(JSON.stringify(d, null, 2));
process.exit(d.status === "BLOCKED" && d.code === "COUNTERPARTY_NOT_ALLOWED" ? 0 : 1);
