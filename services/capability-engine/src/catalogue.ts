import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { dirHashFromDisk } from "@verdict/protocol/node";

/** One verifiable task type: a hashed test package the engine may name in a contract. */
export interface PackageEntry {
  readonly id: string;
  readonly dir: string;
  readonly hash: string;
  readonly format: number;
  readonly description: string;
}

/** What the UI may see (no directory). */
export interface TaskTypeView {
  id: string;
  description: string;
  format: number;
  package_sha256: string;
}

export function packagesRoot(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.VERIFIER_PACKAGES_ROOT ?? "verifier-packages");
}

/** Every package directory under root except `_judge` and dot-dirs. A directory that cannot be read or hashed is skipped. */
export async function loadCatalogue(root: string): Promise<PackageEntry[]> {
  const out: PackageEntry[] = [];
  if (!existsSync(root)) return out;
  for (const name of readdirSync(root).sort()) {
    if (name === "_judge" || name.startsWith(".")) continue;
    const dir = join(root, name);
    try {
      if (!statSync(dir).isDirectory()) continue;
      const m = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as {
        id?: unknown;
        description?: unknown;
        format?: unknown;
      };
      out.push({
        id: typeof m.id === "string" && m.id !== "" ? m.id : basename(dir),
        dir,
        hash: await dirHashFromDisk(dir),
        format: typeof m.format === "number" ? m.format : 1,
        description: typeof m.description === "string" ? m.description : "",
      });
    } catch {
      // not a usable package
    }
  }
  return out;
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
  constructor(readonly entries: readonly PackageEntry[]) {}
  byId(id: string): PackageEntry | undefined {
    return this.entries.find((e) => e.id === id);
  }
  byHash(hash: string): PackageEntry | undefined {
    return this.entries.find((e) => e.hash === hash);
  }
  view(): TaskTypeView[] {
    return this.entries.map((e) => ({
      id: e.id,
      description: e.description,
      format: e.format,
      package_sha256: e.hash,
    }));
  }
  /** "csv2json-v1 (…), json-normalise-v1 (…)" for refusal messages. */
  describe(): string {
    return this.entries
      .map((e) => (e.description ? `${e.id} (${e.description})` : e.id))
      .join(", ");
  }
}
