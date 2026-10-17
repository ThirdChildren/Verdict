import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveDataDir } from "@verdict/identity";

export type WalletRole = "buyer" | "worker";

export interface DaemonConfig {
  role: WalletRole;
  /** HTTP port, always bound to 127.0.0.1. */
  port: number;
  /** Lightning peer port of the RLN node. */
  lnPort: number;
  dataDir: string;
  seedFile: string;
}

const DEFAULTS = { buyer: { port: 7411, ln: 9801 }, worker: { port: 7412, ln: 9802 } } as const;

/** Role comes from WALLET_ROLE (or argv[2]); everything else defaults to the regtest layout of infra/regtest. */
export function daemonConfig(
  env: NodeJS.ProcessEnv = process.env,
  argv: string[] = process.argv,
): DaemonConfig {
  const role = env.WALLET_ROLE ?? argv[2];
  if (role !== "buyer" && role !== "worker")
    throw new Error('Set WALLET_ROLE (or pass the role as argument) to "buyer" or "worker"');
  const base = join(resolveDataDir(env), "regtest");
  return {
    role,
    port: Number(env.WALLET_PORT ?? DEFAULTS[role].port),
    lnPort: Number(env.WALLET_LN_PORT ?? DEFAULTS[role].ln),
    dataDir: env.WALLET_DATA_DIR ?? join(base, "nodes", role),
    seedFile: env.WALLET_SEED_FILE ?? join(base, "shared", `${role}.seed`),
  };
}

export const readSeed = (file: string): string => readFileSync(file, "utf8").trim();
