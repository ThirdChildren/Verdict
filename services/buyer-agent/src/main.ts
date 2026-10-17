import { defaultUiOrigins } from "@verdict/http-local";
import { loadPeers, resolveDataDir } from "@verdict/identity";
import { loadLlm } from "@verdict/llm";
import { createEd25519Signer } from "@verdict/protocol";
import type { ActiveCap } from "./attack.js";
import { EngineClient } from "./engine-client.js";
import { loadBuyerSeed, loadIdentities, workerDirectory } from "./identities.js";
import { buildServer, SERVICE } from "./server.js";

const port = Number(process.env.BUYER_PORT ?? 7402);
const host = "127.0.0.1";
const dataDir = resolveDataDir();
const identities = loadIdentities(dataDir);
const workers = workerDirectory(identities);
const engineUrl = loadPeers().engine;
const signer = await createEd25519Signer(loadBuyerSeed(dataDir));
const engine = new EngineClient({ baseUrl: engineUrl, engineId: identities.engine, signer });

/** Active child capability from the engine; null when there is none or the engine is unreachable. */
const getActiveCap = async (): Promise<ActiveCap | null> => {
  try {
    const res = await fetch(`${engineUrl}/api/mandate/active`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const b = (await res.json()) as Partial<ActiveCap>;
    if (
      typeof b.cap_hash !== "string" ||
      typeof b.expires_at !== "string" ||
      typeof b.remaining !== "string" ||
      !Array.isArray(b.allowed_categories)
    )
      return null;
    return b as ActiveCap;
  } catch {
    return null;
  }
};
const getCapHash = async (): Promise<string | null> => (await getActiveCap())?.cap_hash ?? null;
const model = process.env.BUYER_MODEL ?? "QWEN3_8B_INST_Q4_K_M";

// Fail closed: if the model cannot load the service still starts and answers 503 NOT_READY.
const llm = await loadLlm({ model, ctxSize: 8192, seed: 1, temperature: 0.2 }).catch(
  (err: unknown) => {
    console.error(`[${SERVICE}] model load failed: ${String(err)}`);
    return null;
  },
);
const app = buildServer({
  localOnly: { port, uiOrigins: defaultUiOrigins() },
  ...(llm ? { llm } : {}),
  workers,
  engine,
  getCapHash,
  getActiveCap,
});
app.log.info({ model, loaded: llm !== null, loadMs: llm?.loadMs }, "model status");
try {
  await app.listen({ port, host });
} catch (err) {
  app.log.error({ err, service: SERVICE }, "failed to start");
  process.exit(1);
}
