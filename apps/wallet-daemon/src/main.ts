import { createRlnAccount, RlnWallet, rlnConfigFromEnv } from "@verdict/wallet";
import { daemonConfig, readSeed } from "./config.js";
import { buildWalletServer, SERVICE } from "./server.js";

const cfg = daemonConfig();
const HOST = "127.0.0.1"; // never exposed beyond this machine

const handle = await createRlnAccount(
  rlnConfigFromEnv(readSeed(cfg.seedFile), cfg.dataDir, cfg.lnPort, cfg.role),
);
const wallet = new RlnWallet(handle.account, { onClose: () => handle.dispose() });
await wallet.init();

const app = await buildWalletServer({
  localOnly: { port: cfg.port, uiOrigins: [] }, // no browser may call a wallet
  wallet,
  role: cfg.role,
  logger: true,
  admin: { listChannels: () => handle.account.listChannels() },
});

let stopping = false;
async function stop(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  app.log.info({ signal, service: SERVICE }, "shutting down");
  try {
    await app.close();
    await wallet.close();
  } catch (err) {
    // dispose() of the WDK manager throws after the node is already down; the node is stopped, so log and exit cleanly
    app.log.warn({ err }, "error during shutdown (swallowed)");
  }
  process.exit(0);
}
process.on("SIGINT", () => void stop("SIGINT"));
process.on("SIGTERM", () => void stop("SIGTERM"));

try {
  await app.listen({ port: cfg.port, host: HOST });
  app.log.info({ role: cfg.role, nodeId: await wallet.nodeId() }, "wallet daemon ready");
} catch (err) {
  app.log.error({ err, service: SERVICE }, "failed to start");
  process.exit(1);
}
