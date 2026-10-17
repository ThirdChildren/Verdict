import type { NetworkFacts } from "@verdict/wallet";

export interface BitcoindRpc {
  url: string;
  user: string;
  password: string;
}

/** Env BITCOIND_RPC_* overrides network.json (written by regtest:setup), which overrides the regtest defaults. */
export function resolveBitcoindRpc(
  env: NodeJS.ProcessEnv,
  facts?: Pick<NetworkFacts, "bitcoind_rpc">,
): BitcoindRpc {
  const f = facts?.bitcoind_rpc;
  const hostUrl =
    env.BITCOIND_RPC_HOST || env.BITCOIND_RPC_PORT
      ? `http://${env.BITCOIND_RPC_HOST ?? "127.0.0.1"}:${env.BITCOIND_RPC_PORT ?? "18443"}`
      : undefined;
  return {
    url: env.BITCOIND_RPC_URL ?? hostUrl ?? f?.url ?? "http://127.0.0.1:18443",
    user: env.BITCOIND_RPC_USER ?? f?.user ?? "user",
    password: env.BITCOIND_RPC_PASSWORD ?? f?.password ?? "password",
  };
}

/** Block height from bitcoind (JSON-RPC `getblockcount`). Read-only; the wallet port exposes no height. */
export function bitcoindHeight(
  rpc: BitcoindRpc,
  fetchImpl: typeof fetch = fetch,
): () => Promise<number> {
  const auth = Buffer.from(`${rpc.user}:${rpc.password}`).toString("base64");
  return async () => {
    const res = await fetchImpl(rpc.url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Basic ${auth}` },
      body: JSON.stringify({ jsonrpc: "1.0", id: "verdict", method: "getblockcount", params: [] }),
      signal: AbortSignal.timeout(3000),
    });
    const j = (await res.json()) as { result?: unknown };
    if (typeof j.result !== "number" || !Number.isSafeInteger(j.result) || j.result < 0)
      throw new Error("bitcoind returned no block height");
    return j.result;
  };
}
