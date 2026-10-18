import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
import {
  Catalogue,
  intersectWithVerifier,
  logCatalogue,
  packagesRoot,
  scanCatalogue,
} from "./catalogue.js";
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
  const root = packagesRoot();
  const { entries: found, scanned } = await scanCatalogue(root);
  const verifierUrl = peers.verifier;
  const meet = await intersectWithVerifier(found, verifierUrl);
  logCatalogue(root, meet.entries);
  if (!meet.filtered)
    console.warn(
      `WARNING: the verifier at ${verifierUrl} gave no package list; all local task types are kept and will be re-checked at the first offer.`,
    );
  const catalogue = new Catalogue(
    meet.entries,
    scanned,
    meet.filtered
      ? undefined
      : async () => {
          const r = await intersectWithVerifier(found, verifierUrl);
          return r.filtered ? r.entries : null;
        },
  );
  // Default package for a task with no type, used only while the root holds exactly one package.
  const defaultPackage = catalogue.defaultEntry?.hash;
  app = await buildServer({
    ledger,
    localOnly,
    catalogue,
    verifierUrl,
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
              packageSha256: defaultPackage ?? "",
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
