// Package manifest, format 2 (verifier-packages/_judge/README.md). A manifest without `format` is format 1 and is
// handled by the runner's original reader, untouched.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const CHECK_KINDS = [
  "fixtures",
  "schema",
  "property",
  "static",
  "limits",
  "differential",
  "spec",
] as const;
export type CheckKind = (typeof CHECK_KINDS)[number];

export interface CheckV2 {
  id: string;
  kind: CheckKind;
  weight: number;
  required: boolean;
  params: Record<string, unknown>;
}

export interface ProfileV2 {
  min_score: number;
  required_overrides: Record<string, boolean>;
  tolerances: Record<string, unknown>;
  determinism: "judge" | "full";
}

export interface ManifestV2 {
  format: 2;
  id: string;
  description?: string;
  profile: string;
  entry: string;
  cases_dir: string;
  visible_dir?: string;
  input_ext: string;
  expected_ext: string;
  output_ext: string;
  case_timeout_seconds: number;
  max_output_bytes: number;
  judge_sha256: string;
  checks: CheckV2[];
  profiles: Record<string, ProfileV2>;
}

export interface ManifestIssue {
  path: string;
  message: string;
}

export type ManifestParse =
  | { ok: true; format: 1 }
  | { ok: true; format: 2; manifest: ManifestV2 }
  | { ok: false; issues: ManifestIssue[] };

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const plainName = (v: unknown): v is string =>
  typeof v === "string" && v !== "" && v !== ".." && !/[\\/\0]/.test(v);
const safeRel = (v: unknown): v is string =>
  typeof v === "string" &&
  v !== "" &&
  !v.startsWith("/") &&
  !v.includes("\\") &&
  !v.includes("\0") &&
  !v.split("/").includes("..");
const num = (v: unknown, lo: number, hi: number): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;

/**
 * Hand-written validator (no dependency). `format` absent is format 1 and is left to the runner's original reader.
 * Format 2 is validated completely; every problem is reported with its path.
 */
export function parseManifest(raw: unknown): ManifestParse {
  if (!isObj(raw))
    return { ok: false, issues: [{ path: "", message: "manifest must be an object" }] };
  if (!("format" in raw)) return { ok: true, format: 1 };
  const issues: ManifestIssue[] = [];
  const bad = (path: string, message: string): void => void issues.push({ path, message });
  if (raw.format !== 2) {
    return { ok: false, issues: [{ path: "format", message: "format must be 2 when present" }] };
  }
  if (typeof raw.id !== "string" || raw.id === "") bad("id", "must be a non-empty string");
  if (raw.description !== undefined && typeof raw.description !== "string")
    bad("description", "must be a string");
  if (typeof raw.profile !== "string" || raw.profile === "")
    bad("profile", "must be a non-empty string");
  for (const k of ["entry", "cases_dir", "input_ext", "expected_ext", "output_ext"])
    if (!plainName(raw[k])) bad(k, "must be a plain file name");
  if (raw.visible_dir !== undefined && !plainName(raw.visible_dir))
    bad("visible_dir", "must be a plain file name");
  if (!num(raw.case_timeout_seconds, Number.MIN_VALUE, 600))
    bad("case_timeout_seconds", "must be a number in (0, 600]");
  if (!(num(raw.max_output_bytes, 1, 16 * 1024 * 1024) && Number.isInteger(raw.max_output_bytes)))
    bad("max_output_bytes", "must be an integer in [1, 16 MiB]");
  if (typeof raw.judge_sha256 !== "string" || !/^[0-9a-f]{64}$/.test(raw.judge_sha256))
    bad("judge_sha256", "must be 64 lowercase hex characters");

  const checks: CheckV2[] = [];
  if (!Array.isArray(raw.checks) || raw.checks.length === 0)
    bad("checks", "must be a non-empty array");
  else {
    const ids = new Set<string>();
    for (const [i, c] of (raw.checks as unknown[]).entries()) {
      const at = `checks[${i}]`;
      if (!isObj(c)) {
        bad(at, "must be an object");
        continue;
      }
      const id = c.id;
      if (
        typeof id !== "string" ||
        id.length > 64 ||
        !/^[A-Za-z0-9._-]+$/.test(id) ||
        id === "_verdict"
      )
        bad(`${at}.id`, "must be 1-64 characters of [A-Za-z0-9._-] and not _verdict");
      else if (ids.has(id)) bad(`${at}.id`, `duplicate check ${id}`);
      else ids.add(id);
      if (!CHECK_KINDS.includes(c.kind as CheckKind))
        bad(`${at}.kind`, `must be one of ${CHECK_KINDS.join(", ")}`);
      if (!num(c.weight, 0, 1000) || !Number.isInteger(c.weight))
        bad(`${at}.weight`, "must be an integer in [0, 1000]");
      if (typeof c.required !== "boolean") bad(`${at}.required`, "must be a boolean");
      const params = c.params ?? {};
      if (!isObj(params)) {
        bad(`${at}.params`, "must be an object");
        continue;
      }
      if (params.compare !== undefined) {
        if (
          (c.kind !== "fixtures" && c.kind !== "differential") ||
          (params.compare !== "json" && params.compare !== "text")
        )
          bad(`${at}.params.compare`, 'must be "json" or "text" and only on fixtures/differential');
        else if (
          params.compare === "text" &&
          ("key_order" in params || "numeric_tolerance" in params)
        )
          bad(`${at}.params`, 'key_order and numeric_tolerance do not apply to compare "text"');
      }
      for (const key of ["file", "cases_dir"])
        if (params[key] !== undefined && !safeRel(params[key]))
          bad(`${at}.params.${key}`, "must be a safe relative path");
      checks.push({
        id: String(id),
        kind: c.kind as CheckKind,
        weight: c.weight as number,
        required: c.required as boolean,
        params,
      });
    }
  }

  const profiles: Record<string, ProfileV2> = {};
  if (!isObj(raw.profiles) || Object.keys(raw.profiles).length === 0)
    bad("profiles", "must be a non-empty object");
  else
    for (const [name, p] of Object.entries(raw.profiles)) {
      const at = `profiles.${name}`;
      if (!isObj(p)) {
        bad(at, "must be an object");
        continue;
      }
      if (!num(p.min_score, 1, 100) || !Number.isInteger(p.min_score))
        bad(`${at}.min_score`, "must be an integer in [1, 100]");
      if (p.determinism !== "judge" && p.determinism !== "full")
        bad(`${at}.determinism`, 'must be "judge" or "full"');
      const ro = p.required_overrides ?? {};
      if (!isObj(ro) || !Object.values(ro).every((v) => typeof v === "boolean"))
        bad(`${at}.required_overrides`, "must map check ids to booleans");
      const tol = p.tolerances ?? {};
      if (!isObj(tol)) bad(`${at}.tolerances`, "must be an object");
      else
        for (const key of ["file", "cases_dir"])
          if (key in tol) bad(`${at}.tolerances.${key}`, "tolerances may not redirect paths");
      profiles[name] = {
        min_score: p.min_score as number,
        determinism: p.determinism as "judge" | "full",
        required_overrides: ro as Record<string, boolean>,
        tolerances: tol as Record<string, unknown>,
      };
      for (const id of Object.keys(isObj(ro) ? ro : {}))
        if (!checks.some((c) => c.id === id))
          bad(`${at}.required_overrides.${id}`, "unknown check id");
    }
  if (
    typeof raw.profile === "string" &&
    Object.keys(profiles).length > 0 &&
    !(raw.profile in profiles)
  )
    bad("profile", `profile ${raw.profile} is not defined`);

  // Floor no profile can relax: a real test must be required, static checks stay required.
  if (issues.length === 0) {
    for (const [name, p] of Object.entries(profiles)) {
      const req = (c: CheckV2): boolean => p.required_overrides[c.id] ?? c.required;
      if (!checks.some((c) => ["fixtures", "schema", "differential"].includes(c.kind) && req(c)))
        bad(
          `profiles.${name}`,
          "at least one fixtures, schema or differential check must be required",
        );
      for (const c of checks)
        if (c.kind === "static" && !req(c))
          bad(`profiles.${name}`, `static check ${c.id} must stay required`);
    }
  }

  if (issues.length > 0) return { ok: false, issues };
  const manifest: ManifestV2 = {
    format: 2,
    id: raw.id as string,
    ...(typeof raw.description === "string" ? { description: raw.description } : {}),
    profile: raw.profile as string,
    entry: raw.entry as string,
    cases_dir: raw.cases_dir as string,
    ...(typeof raw.visible_dir === "string" ? { visible_dir: raw.visible_dir } : {}),
    input_ext: raw.input_ext as string,
    expected_ext: raw.expected_ext as string,
    output_ext: raw.output_ext as string,
    case_timeout_seconds: raw.case_timeout_seconds as number,
    max_output_bytes: raw.max_output_bytes as number,
    judge_sha256: raw.judge_sha256 as string,
    checks,
    profiles,
  };
  return { ok: true, format: 2, manifest };
}

export interface ScoredCheck {
  id: string;
  status: "pass" | "fail";
}

export interface Expected {
  required: Record<string, boolean>;
  weight: Record<string, number>;
  score: number;
  pass: boolean;
}

/** Same arithmetic as the judge: score = 100 * sum(weight of passed) / sum(weight), two decimals. */
export function expectedVerdict(m: ManifestV2, checks: ScoredCheck[]): Expected {
  const profile = m.profiles[m.profile];
  if (profile === undefined) throw new Error("unknown profile");
  const status = new Map(checks.map((c) => [c.id, c.status]));
  const required: Record<string, boolean> = {};
  const weight: Record<string, number> = {};
  let all = 0;
  let passed = 0;
  let requiredOk = true;
  let allPass = true;
  for (const c of m.checks) {
    const ok = status.get(c.id) === "pass";
    const req = profile.required_overrides[c.id] ?? c.required;
    required[c.id] = req;
    weight[c.id] = c.weight;
    all += c.weight;
    if (ok) passed += c.weight;
    else {
      allPass = false;
      if (req) requiredOk = false;
    }
  }
  const score = all === 0 ? (allPass ? 100 : 0) : Math.round((10000 * passed) / all) / 100;
  return { required, weight, score, pass: requiredOk && score >= profile.min_score };
}

export const sha256OfFile = (p: string): string =>
  createHash("sha256").update(readFileSync(p)).digest("hex");

/** verifier-packages/_judge/verify.mjs next to this checkout. */
export const GENERIC_JUDGE_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../verifier-packages/_judge/verify.mjs",
);

let judgeHashCache: string | null | undefined;
/** sha256 of the generic judge, computed once; null if the file is missing. */
export function genericJudgeSha256(): string | null {
  if (judgeHashCache === undefined) {
    try {
      judgeHashCache = sha256OfFile(GENERIC_JUDGE_PATH);
    } catch {
      judgeHashCache = null;
    }
  }
  return judgeHashCache;
}

/** Judges the runner will execute outside the sandbox: the generic judge plus VERIFIER_JUDGE_ALLOW (comma-separated hex). */
export function judgeAllowList(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const out = new Set<string>();
  const own = genericJudgeSha256();
  if (own) out.add(own);
  for (const h of (env.VERIFIER_JUDGE_ALLOW ?? "").split(",")) {
    const t = h.trim().toLowerCase();
    if (/^[0-9a-f]{64}$/.test(t)) out.add(t);
  }
  return out;
}
