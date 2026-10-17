import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultUiOrigins, listenHost } from "@verdict/http-local";
import {
  assertEip191VerifierForMode,
  dataDir,
  loadIdentities,
  loadPeers,
  loadSecretSeed,
  registerWdkEip191Verifier,
} from "@verdict/identity";
import { createEd25519Signer } from "@verdict/protocol";
import { dirHashFromDisk } from "@verdict/protocol/node";
import { Registry } from "./registry.js";
import { requireSandbox } from "./runner.js";
import { buildServer, LAN_ROUTES, SERVICE } from "./server.js";
import { VerifierService } from "./service.js";

const port = Number(process.env.VERIFIER_PORT ?? 7404);
const lanBind = process.env.VERDICT_LAN_BIND;
const lo = {
  port,
  uiOrigins: defaultUiOrigins(),
  ...(lanBind ? { lanBind, lanRoutes: LAN_ROUTES } : {}),
};

let app: ReturnType<typeof buildServer>;
try {
  // The verifier checks buyer and worker contract signatures (eip191). It has no wallet and no seed of a wallet.
  registerWdkEip191Verifier();
  assertEip191VerifierForMode();
  const dir = dataDir();
  const ids = loadIdentities(dir);
  const seed = loadSecretSeed("verifier", dir);
  const peers = loadPeers();
  const signer = await createEd25519Signer(seed);
  if (signer.publicId !== ids.verifier)
    throw new Error("The verifier key does not match identities.json. Run: pnpm keys:init");
  const packageDir =
    process.env.VERIFIER_PACKAGE_DIR ??
    resolve(dirname(fileURLToPath(import.meta.url)), "../../../verifier-packages/csv2json-v1");
  const packageSha = await dirHashFromDisk(packageDir);
  // No escape hatch: without a working sandbox the verifier does not start (M3).
  const sandbox = requireSandbox();
  const service = new VerifierService({
    signer,
    seed,
    packageDir,
    registry: new Registry(
      process.env.VERIFIER_REGISTRY ?? resolve(dir, "verifier", "registry.json"),
    ),
    engineId: ids.engine,
    engineUrl: peers.engine,
    workerUrl: peers.worker,
    log: (msg, extra) => console.log(`[${SERVICE}] ${msg}`, extra ? JSON.stringify(extra) : ""),
  });
  console.log(`[${SERVICE}] ${signer.publicId} package ${packageSha} sandbox ${sandbox}`);
  app = buildServer({
    localOnly: lo,
    service,
    info: () => ({ public_id: signer.publicId, package_sha256: packageSha, sandbox }),
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
