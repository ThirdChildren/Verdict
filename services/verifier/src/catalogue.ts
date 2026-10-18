// Package catalogue (E31 AC13): every package under VERIFIER_PACKAGES_ROOT, keyed by its content hash.
import { lstatSync, readdirSync, readFileSync } from "node:fs";
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
  /** Set only by fromRoot: where to look for packages installed after startup. */
  private root: string | null = null;
  private allow: Set<string> | undefined;
  private warn: (msg: string) => void = (m) => console.warn(`[verifier] ${m}`);
  private lastScan = Number.NEGATIVE_INFINITY;
  private scanning: Promise<number> | null = null;
  /** Minimum gap between two rescans of the packages root. */
  static readonly RESCAN_MIN_MS = 2000;
  now: () => number = () => Date.now();
  /** Number of rescans that actually walked the disk (tests, diagnostics). */
  rescans = 0;

  constructor(private readonly entries: CatalogueEntry[]) {}

  /**
   * Adopt directories that appeared under the root since the last look. New directories only: a known directory whose
   * hash changed is never re-described (it stays refused by the drift check). Debounced; a no-op for a single-dir catalogue.
   * Returns how many packages were adopted.
   */
  async rescan(): Promise<number> {
    if (!this.root) return 0;
    if (this.scanning) return this.scanning;
    const t = this.now();
    if (t - this.lastScan < Catalogue.RESCAN_MIN_MS) return 0;
    this.lastScan = t;
    this.rescans++;
    this.scanning = this.doRescan(this.root).finally(() => {
      this.scanning = null;
    });
    return this.scanning;
  }

  private async doRescan(base: string): Promise<number> {
    let adopted = 0;
    let names: string[];
    try {
      names = readdirSync(base).sort();
    } catch {
      return 0;
    }
    const dirs = new Set(this.entries.map((e) => e.dir));
    for (const name of names) {
      if (name === "_judge" || name.startsWith(".")) continue;
      const dir = join(base, name);
      if (dirs.has(dir)) continue;
      try {
        const st = lstatSync(dir);
        if (st.isSymbolicLink() || !st.isDirectory()) continue;
        const e = await describePackage(dir, this.allow);
        if (this.entries.some((x) => x.id === e.id)) {
          this.warn(`skipping ${dir}: duplicate package id "${e.id}"`);
          continue;
        }
        this.entries.push(e);
        adopted++;
        console.log(
          `[verifier] adopted new package ${e.id} ${e.hash}${e.usable ? "" : " (unusable)"}`,
        );
      } catch (err) {
        this.warn(`skipping ${dir}: ${(err as Error).message}`);
      }
    }
    return adopted;
  }

  static async fromRoot(
    root: string,
    allow?: Set<string>,
    warn: (msg: string) => void = (m) => console.warn(`[verifier] ${m}`),
  ): Promise<Catalogue> {
    const base = resolve(root);
    const out: CatalogueEntry[] = [];
    for (const name of readdirSync(base).sort()) {
      if (name === "_judge" || name.startsWith(".")) continue;
      const dir = join(base, name);
      try {
        const st = lstatSync(dir);
        if (st.isSymbolicLink()) {
          warn(`skipping ${dir}: a symlinked package directory is not allowed`);
          continue;
        }
        if (!st.isDirectory()) continue;
        out.push(await describePackage(dir, allow));
      } catch (e) {
        warn(`skipping ${dir}: ${(e as Error).message}`);
      }
    }
    const seen = new Set<string>();
    for (const e of out) {
      if (seen.has(e.id)) throw new Error(`Duplicate verifier package id "${e.id}" in ${base}.`);
      seen.add(e.id);
    }
    const c = new Catalogue(out);
    c.root = base;
    c.allow = allow;
    c.warn = warn;
    return c;
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
