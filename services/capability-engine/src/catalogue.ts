import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirHashFromDisk } from "@verdict/protocol/node";

/** One verifiable task type: a hashed test package the engine may name in a contract. */
export interface PackageEntry {
  readonly id: string;
  readonly dir: string;
  readonly hash: string;
  readonly format: number;
  readonly title: string;
  readonly description: string;
}

/** What the UI may see (no directory). */
export interface TaskTypeView {
  id: string;
  title: string;
  description: string;
  format: number;
  package_sha256: string;
}

/** Built-in human titles for packages whose manifest has none and whose README heading is just the id. */
export const FALLBACK_TITLES: Readonly<Record<string, string>> = {
  "csv2json-v1": "Convert a CSV file into a JSON array of objects",
  "json-normalise-v1": "Canonical JSON",
};

/** Short human title: manifest title, else README first line (no #, under 80 chars, not just the id), else fallback map, else id. */
export function resolveTitle(id: string, manifestTitle: unknown, dir: string): string {
  if (typeof manifestTitle === "string" && manifestTitle.trim() !== "")
    return manifestTitle.trim().slice(0, 60);
  try {
    const first = readFileSync(join(dir, "README.md"), "utf8").split(/\r?\n/, 1)[0] ?? "";
    const t = first.replace(/^\s*#+\s*/, "").trim();
    if (t !== "" && t.length < 80 && t !== id) return t.slice(0, 60);
  } catch {
    // no README
  }
  return FALLBACK_TITLES[id]?.slice(0, 60) ?? id;
}

/** Repository root's verifier-packages, independent of the process cwd (src/ or dist/ is three levels below it). */
export const DEFAULT_PACKAGES_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../verifier-packages",
);

/** VERIFIER_PACKAGES_ROOT when set (relative values resolve against the cwd), else the repository's verifier-packages. */
export function packagesRoot(env: NodeJS.ProcessEnv = process.env): string {
  const o = env.VERIFIER_PACKAGES_ROOT;
  return o ? resolve(o) : DEFAULT_PACKAGES_ROOT;
}

/** One startup line, plus an ERROR line when the root is missing or holds no loadable package. */
export function logCatalogue(
  root: string,
  entries: readonly PackageEntry[],
  log: (msg: string) => void = (m) => console.log(m),
  error: (msg: string) => void = (m) => console.error(m),
): void {
  log(`catalogue: ${root}, ${entries.length} packages: ${entries.map((e) => e.id).join(", ")}`);
  if (!existsSync(root))
    error(`ERROR: catalogue root ${root} does not exist; no task type can be offered.`);
  else if (entries.length === 0)
    error(`ERROR: catalogue root ${root} holds no packages; no task type can be offered.`);
}

/** Host (with port) of a URL, never credentials, path or query; null when it cannot be parsed. */
export function hostOnly(url: string): string | null {
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
}

/** Asks the verifier for /v0/packages (2 s) and caches the answer for `ttlMs`. Never throws. */
export function makeVerifierProbe(
  url: string | undefined,
  fetchImpl: typeof fetch = fetch,
  now: () => number = Date.now,
  ttlMs = 10_000,
): () => Promise<boolean> {
  let at = Number.NEGATIVE_INFINITY;
  let last = false;
  let inflight: Promise<boolean> | undefined;
  return async () => {
    if (!url) return false;
    if (now() - at < ttlMs) return last;
    inflight ??= (async () => {
      try {
        const r = await fetchImpl(`${url}/v0/packages`, { signal: AbortSignal.timeout(2000) });
        last = r.ok;
      } catch {
        last = false;
      }
      at = now();
      return last;
    })().finally(() => {
      inflight = undefined;
    });
    return inflight;
  };
}

/**
 * Every package directory under root except `_judge` and dot-dirs. A directory that cannot be read, has an invalid
 * manifest or is a symlink is skipped with a warning. `scanned` counts the package directories seen, loaded or not.
 * Two packages with the same id throw: a contract must never be ambiguous about its package.
 */
export async function scanCatalogue(
  root: string,
  warn: (msg: string) => void = (m) => console.warn(m),
): Promise<{ entries: PackageEntry[]; scanned: number }> {
  const out: PackageEntry[] = [];
  let scanned = 0;
  if (!existsSync(root)) return { entries: out, scanned };
  for (const name of readdirSync(root).sort()) {
    if (name === "_judge" || name.startsWith(".")) continue;
    const dir = join(root, name);
    try {
      if (!lstatSync(dir).isDirectory()) {
        if (lstatSync(dir).isSymbolicLink()) {
          scanned++;
          warn(`task type skipped: ${name} is a symbolic link, not a package directory`);
        }
        continue;
      }
    } catch {
      continue;
    }
    scanned++;
    try {
      const m = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as {
        id?: unknown;
        description?: unknown;
        title?: unknown;
        format?: unknown;
      };
      const id = typeof m.id === "string" && m.id !== "" ? m.id : basename(dir);
      out.push({
        id,
        title: resolveTitle(id, m.title, dir),
        dir,
        hash: await dirHashFromDisk(dir),
        format: typeof m.format === "number" ? m.format : 1,
        description: typeof m.description === "string" ? m.description : "",
      });
    } catch (e) {
      warn(
        `task type skipped: ${name} could not be loaded (${e instanceof Error ? e.message : "unreadable"})`,
      );
    }
  }
  const seen = new Set<string>();
  for (const e of out) {
    if (seen.has(e.id))
      throw new Error(`Two test packages use the id "${e.id}"; each task type needs a unique id.`);
    seen.add(e.id);
  }
  return { entries: out, scanned };
}

export async function loadCatalogue(
  root: string,
  warn?: (msg: string) => void,
): Promise<PackageEntry[]> {
  return (await scanCatalogue(root, warn)).entries;
}

/**
 * Keeps only the packages the verifier also reports (`GET <verifier>/v0/packages`). Accepts an array of hashes or of
 * objects with `package_sha256`/`sha256`/`hash`, optionally wrapped in `{packages}` or `{types}`. When the verifier
 * does not answer (or answers in a shape we cannot read) every package is kept and `filtered` is false.
 */
export async function intersectWithVerifier(
  entries: readonly PackageEntry[],
  verifierUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ entries: PackageEntry[]; filtered: boolean }> {
  try {
    const r = await fetchImpl(`${verifierUrl}/v0/packages`, { signal: AbortSignal.timeout(2000) });
    if (!r.ok) return { entries: [...entries], filtered: false };
    const j = (await r.json()) as unknown;
    const list = Array.isArray(j)
      ? j
      : typeof j === "object" && j !== null
        ? ((j as Record<string, unknown>).packages ?? (j as Record<string, unknown>).types)
        : undefined;
    if (!Array.isArray(list)) return { entries: [...entries], filtered: false };
    const hashes = new Set<string>();
    for (const x of list) {
      if (typeof x === "string") hashes.add(x);
      else if (typeof x === "object" && x !== null) {
        const o = x as Record<string, unknown>;
        for (const k of ["package_sha256", "sha256", "hash"])
          if (typeof o[k] === "string") hashes.add(o[k] as string);
      }
    }
    return { entries: entries.filter((e) => hashes.has(e.hash)), filtered: true };
  } catch {
    return { entries: [...entries], filtered: false };
  }
}

export class Catalogue {
  private list: readonly PackageEntry[];
  /**
   * @param scanned package directories seen on disk (default: as many as loaded)
   * @param verify retried on first use while it returns a list; null/undefined means "done or unavailable"
   */
  constructor(
    entries: readonly PackageEntry[],
    readonly scanned: number = entries.length,
    private pendingVerify?: () => Promise<PackageEntry[] | null>,
  ) {
    this.list = entries;
  }
  get entries(): readonly PackageEntry[] {
    return this.list;
  }
  /** The single-package default applies only when the root holds exactly one package directory and it loaded. */
  get defaultEntry(): PackageEntry | undefined {
    return this.scanned === 1 && this.list.length === 1 ? this.list[0] : undefined;
  }
  /** Completes a verifier intersection that failed at startup. Never throws. */
  async ensureVerified(): Promise<void> {
    const v = this.pendingVerify;
    if (!v) return;
    try {
      const r = await v();
      if (r) {
        this.list = r;
        this.pendingVerify = undefined;
      }
    } catch {
      // stays pending
    }
  }
  byId(id: string): PackageEntry | undefined {
    return this.entries.find((e) => e.id === id);
  }
  byHash(hash: string): PackageEntry | undefined {
    return this.entries.find((e) => e.hash === hash);
  }
  view(): TaskTypeView[] {
    return this.entries.map((e) => ({
      id: e.id,
      title: e.title,
      description: e.description,
      format: e.format,
      package_sha256: e.hash,
    }));
  }
  /** "Title one; Title two" for refusal messages (titles only). */
  describe(): string {
    return this.entries.map((e) => e.title).join("; ");
  }
}
