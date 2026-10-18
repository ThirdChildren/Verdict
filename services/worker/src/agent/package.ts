import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirHashFromDisk } from "@verdict/protocol/node";

/** Where the packages live; one subdirectory per package. `_judge` (the shared v2 judge) is not a package. */
const HERE = dirname(fileURLToPath(import.meta.url));
/** Repo-level catalogue, independent of the process cwd. */
export const DEFAULT_PACKAGES_ROOT = resolve(HERE, "../../../../verifier-packages");

export function packagesRoot(): string {
  return resolve(process.env.VERIFIER_PACKAGES_ROOT ?? DEFAULT_PACKAGES_ROOT);
}

const cache = new Map<string, Map<string, string>>();
const logged = new Set<string>();

/** sha256 -> directory for every package under root. Cached per root; pass refresh to rescan. */
export async function packageMap(root: string, refresh = false): Promise<Map<string, string>> {
  const hit = cache.get(root);
  if (hit && !refresh) return hit;
  const map = new Map<string, string>();
  if (existsSync(root)) {
    for (const name of readdirSync(root).sort()) {
      if (name === "_judge" || name.startsWith(".")) continue;
      const dir = join(root, name);
      try {
        if (!statSync(dir).isDirectory()) continue;
        map.set(await dirHashFromDisk(dir), dir);
      } catch {
        // unreadable or contains a symlink: not a usable package
      }
    }
  }
  cache.set(root, map);
  if (!logged.has(root)) {
    logged.add(root);
    const ids = [...map.values()].map((d) => basename(d));
    if (map.size === 0)
      console.error(
        `[worker] ERROR: no verifier packages found under ${root}; every offer will be refused`,
      );
    else console.log(`[worker] verifier packages root ${root}: ${ids.join(", ")}`);
  }
  return map;
}

/** The local directory of the package a contract commits to, or null when this machine does not have it. */
export async function resolvePackageDir(
  sha256: string,
  root = packagesRoot(),
): Promise<string | null> {
  const hit = (await packageMap(root)).get(sha256);
  if (hit) return hit;
  // A package installed after startup: rescan once per RESCAN_MIN_MS, then look again.
  const now = Date.now();
  if (now - (lastRescan.get(root) ?? Number.NEGATIVE_INFINITY) < RESCAN_MIN_MS) return null;
  lastRescan.set(root, now);
  return (await packageMap(root, true)).get(sha256) ?? null;
}

export const RESCAN_MIN_MS = 2000;
const lastRescan = new Map<string, number>();

export interface Manifest {
  format?: number;
  id?: string;
  description?: string;
  entry: string;
  visible_dir?: string;
  input_ext: string;
  expected_ext?: string;
  output_ext?: string;
  checks?: { id: string; kind: string; params?: Record<string, unknown> }[];
}

export function readManifest(dir: string): Manifest {
  return JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as Manifest;
}

/** Package id: the manifest's `id` (v2), else the directory name (v1 has none). */
export function packageId(dir: string, m: Manifest = readManifest(dir)): string {
  return m.id ?? basename(dir);
}

export interface VisiblePair {
  name: string;
  input: string;
  expected: string;
}

/** Everything the prompt may say about a v2 package. Built from the manifest and visible_dir only, never cases_dir. */
export interface PackageTask {
  id: string;
  dir: string;
  description: string;
  entry: string;
  inputExt: string;
  outputExt: string;
  visible: VisiblePair[];
  bannedImports: string[];
  bannedTokens: string[];
  limits: { maxSourceBytes?: number; maxLines?: number };
  spec: string[];
}

export const MAX_VISIBLE_PAIRS = 3;
export const MAX_PAIR_BYTES = 2048;

const cap = (s: string) =>
  s.length > MAX_PAIR_BYTES ? `${s.slice(0, MAX_PAIR_BYTES)}\n[... truncated]` : s;

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

/** Plain words for the closed assertion vocabulary of `spec` checks. Unknown keys are ignored. */
export function specInWords(a: Record<string, unknown>): string[] {
  const out: string[] = [];
  const keys = strings(a.output_keys_required);
  if (keys.length > 0) out.push(`Every output object must contain the keys: ${keys.join(", ")}.`);
  if (typeof a.max_output_bytes === "number")
    out.push(`The output must not exceed ${a.max_output_bytes} bytes.`);
  if (a.numbers_subset_of_input === true)
    out.push("Every number in the output must also appear in the input (invent no numbers).");
  const req = strings(a.required_tokens);
  if (req.length > 0) out.push(`The output must contain: ${req.join(", ")}.`);
  const forb = strings(a.forbidden_tokens);
  if (forb.length > 0) out.push(`The output must not contain: ${forb.join(", ")}.`);
  return out;
}

/** null for a format-1 package (the fixed csv2json prompt applies) or when the manifest is unreadable. */
export function loadPackageTask(dir: string): PackageTask | null {
  let m: Manifest;
  try {
    m = readManifest(dir);
  } catch {
    return null;
  }
  if (m.format !== 2) return null;
  const expectedExt = m.expected_ext ?? ".expected.json";
  const visible: VisiblePair[] = [];
  if (m.visible_dir) {
    const vdir = join(dir, m.visible_dir);
    if (existsSync(vdir)) {
      for (const f of readdirSync(vdir).sort()) {
        if (visible.length >= MAX_VISIBLE_PAIRS) break;
        if (!f.endsWith(m.input_ext) || f.endsWith(expectedExt)) continue;
        const name = f.slice(0, -m.input_ext.length);
        const exp = join(vdir, name + expectedExt);
        if (!existsSync(exp)) continue;
        visible.push({
          name,
          input: cap(readFileSync(join(vdir, f), "utf8")),
          expected: cap(readFileSync(exp, "utf8")),
        });
      }
    }
  }
  const checks = m.checks ?? [];
  const staticP = checks.find((c) => c.kind === "static")?.params ?? {};
  const limitsP = checks.find((c) => c.kind === "limits")?.params ?? {};
  const specFile = checks.find((c) => c.kind === "spec")?.params?.file;
  let spec: string[] = [];
  if (typeof specFile === "string") {
    try {
      spec = specInWords(JSON.parse(readFileSync(join(dir, specFile), "utf8")));
    } catch {
      spec = [];
    }
  }
  const num = (v: unknown) => (typeof v === "number" ? v : undefined);
  return {
    id: packageId(dir, m),
    dir,
    description: m.description ?? "",
    entry: m.entry,
    inputExt: m.input_ext,
    outputExt: m.output_ext ?? ".out.json",
    visible,
    bannedImports: strings(staticP.banned_imports),
    bannedTokens: strings(staticP.banned_tokens),
    limits: {
      ...(num(limitsP.max_source_bytes) !== undefined
        ? { maxSourceBytes: num(limitsP.max_source_bytes) as number }
        : {}),
      ...(num(limitsP.max_lines) !== undefined
        ? { maxLines: num(limitsP.max_lines) as number }
        : {}),
    },
    spec,
  };
}

/** The system prompt of a v2 package, built only from PackageTask. Keeps the one-fenced-block reply contract. */
export function buildPackagePrompt(t: PackageTask): string {
  const lines: string[] = [
    `You are a careful JavaScript engineer. You write exactly one file: ${t.entry}, a zero-dependency Node.js ESM command line tool.`,
    `Usage: node ${t.entry} <input${t.inputExt}>. It reads the input file and prints the result to stdout (the result is saved as ${t.outputExt}). Exit code 0.`,
    "",
    `Task: ${t.description}`,
  ];
  if (t.visible.length > 0) {
    lines.push("", "Examples (input, then the exact expected output):");
    for (const p of t.visible)
      lines.push(
        `--- ${p.name}${t.inputExt} ---`,
        p.input.trimEnd(),
        `--- expected output ---`,
        p.expected.trimEnd(),
      );
  }
  const rules: string[] = [];
  if (t.bannedImports.length > 0) rules.push(`Never import: ${t.bannedImports.join(", ")}.`);
  if (t.bannedTokens.length > 0) rules.push(`Never use: ${t.bannedTokens.join(", ")}.`);
  if (t.limits.maxSourceBytes !== undefined)
    rules.push(`The source file must be at most ${t.limits.maxSourceBytes} bytes.`);
  if (t.limits.maxLines !== undefined)
    rules.push(`The source file must be at most ${t.limits.maxLines} lines.`);
  rules.push(...t.spec);
  if (rules.length > 0) lines.push("", "Rules:", ...rules.map((r) => `- ${r}`));
  lines.push(
    "",
    "The automatic test also runs your tool on other, unseen inputs of the same kind, so handle the general case, not only the examples.",
    "Think briefly. Reply with the complete file in one fenced code block and nothing else.",
  );
  return lines.join("\n");
}
