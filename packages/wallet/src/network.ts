// Network facts written once by `pnpm regtest:setup` to $VERDICT_DATA_DIR/network.json; services read them here.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "@verdict/identity";

export interface NetworkFacts {
  network: "regtest";
  tusd_asset_id: string;
  tusd_precision: number;
  /** Start of this regtest world (ISO). Changes on every demo:reset. Absent in files written before P2.6. */
  reset_epoch?: string;
  written_at: string;
  /** bitcoind JSON-RPC, written by regtest:setup (file is 0600). Env BITCOIND_RPC_* overrides. Never print the password. */
  bitcoind_rpc?: { url: string; user: string; password: string };
}

export function networkPath(dir: string = dataDir()): string {
  return join(dir, "network.json");
}

/** Throws a plain-language error if network.json is missing or malformed (fail closed). */
export function loadNetwork(dir: string = dataDir()): NetworkFacts {
  const p = networkPath(dir);
  if (!existsSync(p)) throw new Error(`No network facts at ${p}. Run: pnpm regtest:setup`);
  const raw = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
  if (typeof raw.tusd_asset_id !== "string" || raw.tusd_asset_id.length === 0)
    throw new Error(`network.json at ${p}: "tusd_asset_id" is missing`);
  if (!Number.isInteger(raw.tusd_precision))
    throw new Error(`network.json at ${p}: "tusd_precision" is missing`);
  return raw as unknown as NetworkFacts;
}
