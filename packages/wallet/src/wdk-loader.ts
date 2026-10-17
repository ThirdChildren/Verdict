import { mkdirSync } from "node:fs";
import type WalletManagerRgbLightning from "@utexo/wdk-rgb-lightning";
import type { WalletAccountRgbLightning } from "@utexo/wdk-rgb-lightning";
import { WalletError } from "./port.js";
import { RlnWallet } from "./rln-wallet.js";

export interface RlnConfig {
  mnemonic: string;
  dataDir: string;
  ldkPeerListeningPort: number;
  alias: string;
  network?: "regtest" | "signet";
  bitcoindRpcUser?: string;
  bitcoindRpcPassword?: string;
  bitcoindRpcHost?: string;
  bitcoindRpcPort?: number;
  indexerUrl?: string;
  proxyEndpoint?: string;
}

/** Env defaults match infra/regtest (official compose; verified P0.3). */
export function rlnConfigFromEnv(
  mnemonic: string,
  dataDir: string,
  ldkPeerListeningPort: number,
  alias: string,
  env: NodeJS.ProcessEnv = process.env,
): RlnConfig {
  return {
    mnemonic,
    dataDir,
    ldkPeerListeningPort,
    alias,
    network: env.VERDICT_NETWORK === "signet" ? "signet" : "regtest",
    bitcoindRpcUser: env.BITCOIND_RPC_USER ?? "user",
    bitcoindRpcPassword: env.BITCOIND_RPC_PASSWORD ?? "password",
    bitcoindRpcHost: env.BITCOIND_RPC_HOST ?? "127.0.0.1",
    bitcoindRpcPort: Number(env.BITCOIND_RPC_PORT ?? 18443),
    indexerUrl: env.INDEXER_URL ?? "tcp://localhost:50001",
    proxyEndpoint: env.RGB_PROXY_URL ?? "rpc://localhost:3000/json-rpc",
  };
}

export interface RlnHandle {
  /** The real WDK account (setup scripts also need createUtxos, sync, getAddress, listChannels, ...). */
  account: WalletAccountRgbLightning;
  dispose(): void;
}

/**
 * KNOWN LIMITATION (beta.15 / node binding beta.16, verified on regtest P2.2): a node restarted over an existing
 * channel cannot move HTLCs. The WDK module builds an ephemeral in-process VLS signer, so after a process restart
 * LDK parks every new HTLC ("next per-commitment secret ... is not available") and payments stay Pending forever.
 * The binding's `createWithStorage` (persistent signer) panics natively at restore (vls-core channel.rs:119). Open
 * the channel in the same process lifetime that uses it (tests/e2e/hodl-lifecycle.e2e.ts does).
 *
 * Creates and unlocks the real node. `@utexo/wdk-rgb-lightning` is imported lazily (only its types are imported
 * statically) so that packages that only use FakeWallet never load the native binding.
 */
/**
 * `WalletManagerRgbLightning.dispose()` (beta.15) shuts the node down first, then the base class reads
 * `account.keyPair`, which needs the already-destroyed signer and throws "attachExternalSigner(seedHex) must be
 * called before bootstrap()". The node IS stopped by then, so that one error is swallowed; any other error is rethrown.
 */
function disposeManager(manager: WalletManagerRgbLightning): void {
  try {
    manager.dispose();
  } catch (e) {
    if (!(e instanceof Error && e.message.includes("must be called before bootstrap()"))) throw e;
  }
}

export async function createRlnAccount(cfg: RlnConfig): Promise<RlnHandle> {
  let Manager: typeof WalletManagerRgbLightning;
  try {
    Manager = (await import("@utexo/wdk-rgb-lightning")).default;
  } catch (e) {
    throw new WalletError(
      "WALLET_NODE_ERROR",
      `Cannot load @utexo/wdk-rgb-lightning: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  mkdirSync(cfg.dataDir, { recursive: true, mode: 0o700 });
  const manager = new Manager(cfg.mnemonic, {
    network: cfg.network ?? "regtest",
    dataDir: cfg.dataDir,
    ldkPeerListeningPort: cfg.ldkPeerListeningPort,
    daemonListeningPort: 0,
  });
  const account = await manager.getAccount(0);
  // The unlock request is the native snake_case JSON (typed `object` upstream); the wallet config's camelCase
  // bitcoindRpc*/indexerUrl/proxyEndpoint fields are not used here (P0.3 unlocked this way).
  await account.unlock({
    bitcoind_rpc_username: cfg.bitcoindRpcUser,
    bitcoind_rpc_password: cfg.bitcoindRpcPassword,
    bitcoind_rpc_host: cfg.bitcoindRpcHost,
    bitcoind_rpc_port: cfg.bitcoindRpcPort,
    indexer_url: cfg.indexerUrl,
    proxy_endpoint: cfg.proxyEndpoint,
    announce_addresses: [],
    announce_alias: cfg.alias,
  });
  return { account, dispose: () => disposeManager(manager) };
}

export async function createRlnWallet(cfg: RlnConfig): Promise<RlnWallet> {
  const h = await createRlnAccount(cfg);
  const w = new RlnWallet(h.account, { onClose: () => h.dispose() });
  await w.init();
  return w;
}
