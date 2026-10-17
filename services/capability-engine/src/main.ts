import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirHashFromDisk } from "@verdict/protocol/node";
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
import { bitcoindHeight, resolveBitcoindRpc } from "./chain.js";
import { hardLimits } from "./config.js";
import { contractLimits } from "./contract-config.js";
import { mineOneBlockAsync } from "./demo-mine.js";
import { Ledger } from "./ledger/index.js";
import { buildServer, engineConfig, SERVICE } from "./server.js";
import { eip191SignerFromSeed } from "./signer.js";

const { port, host, localOnly } = engineConfig();

let app: Awaited<ReturnType<typeof buildServer>>;
try {
  registerWdkEip191Verifier();
  assertEip191VerifierForMode();
  const dir = dataDir();
  const identities = loadIdentities(dir);
  const engineSigner = await eip191SignerFromSeed(loadSecretSeed("engine", dir));
  if (engineSigner.publicId !== identities.engine)
    throw new Error("The engine key does not match identities.json. Run: pnpm keys:init");
  mkdirSync(dir, { recursive: true });
  const ledger = Ledger.open(
    process.env.ENGINE_LEDGER_PATH ?? join(dir, "engine-ledger.sqlite"),
    2,
  );
  const peers = loadPeers();
  const limits = contractLimits();
  const walletOn = process.env.VERDICT_WALLET === "1";
  const verifierPackage = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../../verifier-packages/csv2json-v1",
  );
  app = await buildServer({
    ledger,
    localOnly,
    chainHeight: bitcoindHeight(resolveBitcoindRpc(process.env, loadNetwork(dir))),
    identities,
    ...(walletOn
      ? {
          wallet: new WalletClient({
            baseUrl: process.env.WALLET_BUYER_URL ?? "http://127.0.0.1:7411",
          }),
          offer: {
            verifier: {
              publicId: identities.verifier,
              endpoint: peers.verifier,
              packageSha256: await dirHashFromDisk(verifierPackage),
            },
            workerUrl: peers.worker,
            maxLockSeconds: limits.max_lock_seconds,
            safetyMarginSeconds: limits.safety_margin_seconds,
            maxVerifySeconds: 60,
            expirySeconds: 3600,
            expiryBlocks: 42,
          },
        }
      : {}),
    demo: {
      enabled: process.env.VERDICT_DEMO_TOGGLES === "1",
      mine: mineOneBlockAsync(resolve(dirname(fileURLToPath(import.meta.url)), "../../..")),
    },
    engineSigner,
    limits: hardLimits(),
    assetId: loadNetwork(dir).tusd_asset_id,
    precision: 2,
    preapprovedWorkers: [identities.worker],
  });
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

try {
  await app.listen({ port, host });
} catch (err) {
  app.log.error({ err, service: SERVICE }, "failed to start");
  process.exit(1);
}
