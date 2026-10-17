// `pnpm net:info`: a safe summary of the network facts. Built from an allowlist of fields, never from file contents.
import { loadNetwork } from "./network.js";

export interface NetInfo {
  network: string;
  tusd_asset_id: string;
  tusd_precision: number;
  /** URL only; user and password stay in network.json. */
  bitcoind_rpc_url?: string;
  services: Record<string, string>;
  wallet_daemons: Record<string, string>;
}

/** Drops any user:password@ part, so a URL that carries credentials is still safe to print. */
function stripAuth(u: string): string {
  return u.replace(/\/\/[^/@]*@/, "//");
}

/** Throws if network.json is missing. Reads only `network.json`, and copies only the named fields. */
export function netInfo(dir: string, env: NodeJS.ProcessEnv = process.env): NetInfo {
  const n = loadNetwork(dir);
  const port = (name: string, def: number) => String(env[name] ?? def);
  return {
    network: String(n.network),
    tusd_asset_id: String(n.tusd_asset_id),
    tusd_precision: Number(n.tusd_precision),
    ...(typeof n.bitcoind_rpc?.url === "string"
      ? { bitcoind_rpc_url: stripAuth(n.bitcoind_rpc.url) }
      : {}),
    services: {
      engine: `http://127.0.0.1:${port("ENGINE_PORT", 7401)}`,
      buyer_agent: `http://127.0.0.1:${port("BUYER_PORT", 7402)}`,
      principal_signer: `http://127.0.0.1:${port("PRINCIPAL_SIGNER_PORT", 7403)}`,
    },
    wallet_daemons: {
      buyer: `http://127.0.0.1:7411 (ln ${port("WALLET_LN_PORT_BUYER", 9801)})`,
      worker: `http://127.0.0.1:7412 (ln ${port("WALLET_LN_PORT_WORKER", 9802)})`,
    },
  };
}
