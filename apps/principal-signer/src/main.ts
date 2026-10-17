import { defaultUiOrigins } from "@verdict/http-local";
import {
  dataDir,
  loadIdentities,
  loadNetwork,
  loadSecretSeed,
  registerWdkEip191Verifier,
} from "@verdict/wallet";
import { buildSignerServer, DEFAULT_PORT, SERVICE } from "./server.js";
import { eip191SignerFromSeed } from "./signer.js";

const port = Number(process.env.PRINCIPAL_SIGNER_PORT ?? DEFAULT_PORT);
// Never exposed beyond this machine: no LAN routes, loopback only.
const HOST = "127.0.0.1";

let app: ReturnType<typeof buildSignerServer>;
try {
  registerWdkEip191Verifier();
  const dir = dataDir();
  const identities = loadIdentities(dir);
  const signer = await eip191SignerFromSeed(loadSecretSeed("principal", dir));
  if (signer.publicId !== identities.principal)
    throw new Error("The principal key does not match identities.json. Run: pnpm keys:init");
  app = buildSignerServer({
    localOnly: { port, uiOrigins: defaultUiOrigins() },
    signer,
    principalId: identities.principal,
    assetId: loadNetwork(dir).tusd_asset_id,
  });
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

try {
  await app.listen({ port, host: HOST });
} catch (err) {
  app.log.error({ err, service: SERVICE }, "failed to start");
  process.exit(1);
}
