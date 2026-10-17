import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveDataDir } from "./data-dir.js";

export const PEER_ROLES = ["engine", "worker", "verifier"] as const;
export type PeerRole = (typeof PEER_ROLES)[number];
export type Peers = Record<PeerRole, string>;

export const DEFAULT_PEERS: Peers = {
  engine: "http://127.0.0.1:7401",
  worker: "http://127.0.0.1:7405",
  verifier: "http://127.0.0.1:7404",
};

const ENV_NAMES: Record<PeerRole, string> = {
  engine: "ENGINE_URL",
  worker: "WORKER_URL",
  verifier: "VERIFIER_URL",
};

/** Origin only (http or https, host and port), no credentials, path or query. Returns it without a trailing slash. */
export function normalizePeerUrl(role: PeerRole, raw: unknown, source: string): string {
  const bad = (why: string) =>
    new Error(
      `${source}: the ${role} URL ${JSON.stringify(raw)} ${why}. Example: ${DEFAULT_PEERS[role]}`,
    );
  if (typeof raw !== "string") throw bad("must be a string");
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw bad("is not a valid URL");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:")
    throw bad("must start with http:// or https://");
  if (u.username || u.password) throw bad("must not contain a user name or password");
  if ((u.pathname !== "/" && u.pathname !== "") || u.search || u.hash)
    throw bad("must be just host and port, without a path");
  return u.origin;
}

/**
 * Where the other nodes are, as seen from THIS machine. Order: ENGINE_URL / WORKER_URL / VERIFIER_URL,
 * then peers.json (VERDICT_PEERS_FILE, else <data dir>/peers.json), then loopback defaults.
 * On the Legion only `verifier` differs from the defaults; on the Mac `engine` and `worker` do.
 */
export function loadPeers(env: NodeJS.ProcessEnv = process.env): Peers {
  const file = env.VERDICT_PEERS_FILE?.trim() || join(resolveDataDir(env), "peers.json");
  let fromFile: Record<string, unknown> = {};
  if (existsSync(file)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
      fromFile = parsed as Record<string, unknown>;
    } catch {
      throw new Error(`${file} is not a JSON object like {"verifier": "http://192.168.1.20:7404"}`);
    }
    for (const k of Object.keys(fromFile))
      if (!(PEER_ROLES as readonly string[]).includes(k))
        throw new Error(`${file}: unknown entry "${k}" (allowed: ${PEER_ROLES.join(", ")})`);
  }
  const out = { ...DEFAULT_PEERS };
  for (const role of PEER_ROLES) {
    const fromEnv = env[ENV_NAMES[role]]?.trim();
    if (fromEnv) out[role] = normalizePeerUrl(role, fromEnv, ENV_NAMES[role]);
    else if (fromFile[role] !== undefined) out[role] = normalizePeerUrl(role, fromFile[role], file);
  }
  return out;
}
