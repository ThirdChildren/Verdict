// Package catalogue (E31 AC13): every package under VERIFIER_PACKAGES_ROOT, keyed by its content hash.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { dirHashFromDisk } from "@verdict/protocol/node";
import { judgeAllowList, parseManifest } from "./manifest.js";

export interface CatalogueEntry {
  id: string;
  dir: string;
  hash: string;
  format: 1 | 2;
  profile: string | null;
  usable: boolean;
  /** Why a package is listed but not usable. Never shown over HTTP. */
  reason?: string;
}

/** The public shape: no directory. */
export const publicEntry = (e: CatalogueEntry) => ({
  id: e.id,
  hash: e.hash,
  format: e.format,
  profile: e.profile,
  usable: e.usable,
});

export async function describePackage(
  dir: string,
  allow: Set<string> = judgeAllowList(),
): Promise<CatalogueEntry> {
  const hash = await dirHashFromDisk(dir);
  let id = basename(dir);
  let format: 1 | 2 = 1;
  let profile: string | null = null;
  let usable = true;
  let reason: string | undefined;
  try {
    const raw = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as { id?: unknown };
    if (typeof raw.id === "string" && raw.id) id = raw.id;
    const p = parseManifest(raw);
    if (!p.ok) {
      usable = false;
      reason = `manifest invalid: ${p.issues.map((i) => i.path).join(", ")}`;
    } else if (p.format === 2) {
      format = 2;
      profile = p.manifest.profile;
      if (!allow.has(p.manifest.judge_sha256)) {
        usable = false;
        reason = "judge_sha256 is not allow-listed";
      }
    }
  } catch (e) {
    usable = false;
    reason = `manifest unreadable (${(e as Error).message})`;
  }
  return { id, dir, hash, format, profile, usable, ...(reason ? { reason } : {}) };
}

export class Catalogue {
  constructor(private readonly entries: CatalogueEntry[]) {}

  static async fromRoot(root: string, allow?: Set<string>): Promise<Catalogue> {
    const base = resolve(root);
    const out: CatalogueEntry[] = [];
    for (const name of readdirSync(base).sort()) {
      if (name === "_judge" || name.startsWith(".")) continue;
      const dir = join(base, name);
      try {
        if (!statSync(dir).isDirectory()) continue;
        out.push(await describePackage(dir, allow));
      } catch {
        // an unreadable directory is simply not in the catalogue
      }
    }
    return new Catalogue(out);
  }

  /** VERIFIER_PACKAGE_DIR: the catalogue is that one package. */
  static async fromDir(dir: string, allow?: Set<string>): Promise<Catalogue> {
    return new Catalogue([await describePackage(resolve(dir), allow)]);
  }

  list(): CatalogueEntry[] {
    return this.entries;
  }
  get size(): number {
    return this.entries.length;
  }
  byHash(hash: string): CatalogueEntry | undefined {
    return this.entries.find((e) => e.hash === hash);
  }
}
