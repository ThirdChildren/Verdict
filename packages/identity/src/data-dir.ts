import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/**
 * The one place that decides where keys, identities.json and network.json live:
 * VERDICT_DATA_DIR if set (a leading "~" is expanded), else ~/.verdict-data. Always absolute,
 * so the answer never depends on a service's working directory.
 */
export function resolveDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.VERDICT_DATA_DIR?.trim();
  if (!raw) return join(homedir(), ".verdict-data");
  const expanded = raw === "~" || raw.startsWith("~/") ? join(homedir(), raw.slice(1)) : raw;
  return isAbsolute(expanded) ? expanded : resolve(expanded);
}
