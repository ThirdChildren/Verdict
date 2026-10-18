import { join } from "node:path";
import { defaultUiOrigins, listenHost } from "@verdict/http-local";
import { loadLlm } from "@verdict/llm";
import {
  assertEip191VerifierForMode,
  dataDir,
  loadIdentities,
  loadNetwork,
  loadPeers,
  loadSecretSeed,
  registerWdkEip191Verifier,
  WalletClient,
} from "@verdict/wallet";
import { DEFAULT_MAX_TOKENS, llmGenerator } from "./agent/generate.js";
import { loadPackageTask, resolvePackageDir } from "./agent/package.js";
import { localSelfCheck } from "./agent/selfcheck.js";
import { WorkerNode } from "./node/node.js";
import { buildServer, LAN_ROUTES, SERVICE } from "./server.js";
import { eip191SignerFromSeed } from "./signer.js";
import { StreamHub } from "./stream.js";

const port = Number(process.env.WORKER_PORT ?? 7405);
const lanBind = process.env.VERDICT_LAN_BIND;
const lo = {
  port,
  uiOrigins: defaultUiOrigins(),
  ...(lanBind ? { lanBind, lanRoutes: LAN_ROUTES } : {}),
};
const model = process.env.WORKER_MODEL ?? "QWEN3_5_9B_MULTIMODAL_Q4_K_M";

// Demo switch for the FAIL -> refund scene; the UI flips it through POST /v0/config. Never on by default.
let sabotaged = process.env.WORKER_SABOTAGED === "1";
// Demo switch for the "worker disappears" scene: after the verdict it neither claims nor cancels. Never on by default.
let disappears = process.env.WORKER_DISAPPEARS === "1";
let app: ReturnType<typeof buildServer>;
try {
  registerWdkEip191Verifier();
  assertEip191VerifierForMode();
  const dir = dataDir();
  const ids = loadIdentities(dir);
  const net = loadNetwork(dir);
  const signer = await eip191SignerFromSeed(loadSecretSeed("worker", dir));
  if (signer.publicId !== ids.worker)
    throw new Error("The worker key does not match identities.json. Run: pnpm keys:init");
  const wallet = new WalletClient({
    baseUrl: process.env.WALLET_WORKER_URL ?? "http://127.0.0.1:7412",
  });
  await wallet.init();
  // Load at startup, never lazily; loadLlm runs the warm-up completion (SDK_NOTES P0.2b).
  const llm = await loadLlm({ model, ctxSize: 16384, seed: 1, temperature: 0.6 });
  console.log(`[${SERVICE}] ${model} loaded in ${llm.loadMs} ms`);
  const stream = new StreamHub();
  const maxTokens = Number(process.env.WORKER_MAX_TOKENS ?? DEFAULT_MAX_TOKENS);
  const node = new WorkerNode({
    stream,
    signer,
    engineId: ids.engine,
    engineUrl: loadPeers().engine,
    wallet,
    assetId: net.tusd_asset_id,
    precision: net.tusd_precision,
    // Format-2 packages drive the prompt from their manifest; csv2json-v1 keeps its measured prompt.
    generatorFor: (dir) => llmGenerator(llm, maxTokens, loadPackageTask(dir)),
    checkFor: (dir) => localSelfCheck({ packageDir: dir }),
    resolvePackageDir: (sha) => resolvePackageDir(sha),
    sabotaged: () => sabotaged,
    disappears: () => disappears,
    verifierId: ids.verifier,
    deliveryRoot: join(dir, "worker", "deliveries"),
    log: (msg, extra) => console.log(`[${SERVICE}] ${msg}`, extra ? JSON.stringify(extra) : ""),
  });
  node.start();
  app = buildServer({
    localOnly: lo,
    node,
    stream,
    sabotage: {
      get: () => sabotaged,
      set: (on) => {
        sabotaged = on;
      },
    },
    disappear: {
      get: () => disappears,
      set: (on) => {
        disappears = on;
      },
    },
    info: async () => ({ public_id: signer.publicId, node_id: await wallet.nodeId() }),
  });
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

try {
  await app.listen({ port, host: listenHost(lo) });
} catch (err) {
  app.log.error({ err, service: SERVICE }, "failed to start");
  process.exit(1);
}
