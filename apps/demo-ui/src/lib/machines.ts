import { isMock } from "./mode.js";

export type MachineRole = "engine" | "worker" | "verifier";
export type Machines = Record<MachineRole, string>;

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const hostOnly = (hostPort: string): string => hostPort.replace(/:\d+$/, "");

/** Host of each service, exactly as this page reaches it (same override rules as the API modules). */
export function serviceHosts(
  search: string,
  env: Record<string, string | undefined>,
  page: string,
) {
  const q = new URLSearchParams(search);
  const pick = (param: string, envHost: string | undefined) => {
    const v = q.get(param);
    return hostOnly(v ?? envHost ?? page);
  };
  return {
    engine: pick("engine", env.VITE_ENGINE_HOST),
    worker: pick("worker", env.VITE_ENGINE_HOST),
    verifier: pick("verifier", env.VITE_VERIFIER_HOST),
  } satisfies Machines;
}

/** Optional friendly names: VITE_HOST_NAMES="192.168.1.20=Mac,localhost=Legion". */
export function parseHostNames(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (raw ?? "").split(",")) {
    const [host, name] = part.split("=").map((x) => x.trim());
    if (host && name) out[host] = name;
  }
  return out;
}

const sameHost = (a: string, b: string) => a === b || (LOOPBACK.has(a) && LOOPBACK.has(b));

/**
 * Machine label per service, derived from the hosts configured for this screen (the same peers the engine uses).
 * A service on the engine's own machine is "This computer"; another host is shown by its name or address.
 */
export function machineLabels(hosts: Machines, names: Record<string, string> = {}): Machines {
  const label = (role: MachineRole) => {
    const h = hosts[role];
    const named = names[h] ?? (sameHost(h, hosts.engine) ? names[hosts.engine] : undefined);
    if (named) return named;
    return sameHost(h, hosts.engine) ? "This computer" : h;
  };
  return { engine: label("engine"), worker: label("worker"), verifier: label("verifier") };
}

/** MOCK DATA: plan B layout (verifier on a second computer) so the label logic is visible in the storyboard. */
const MOCK_HOSTS: Machines = { engine: "localhost", worker: "localhost", verifier: "192.168.50.2" };

export function currentMachines(): Machines {
  if (isMock()) return machineLabels(MOCK_HOSTS);
  return machineLabels(
    serviceHosts(location.search, import.meta.env, location.hostname),
    parseHostNames(import.meta.env.VITE_HOST_NAMES),
  );
}
