import { z } from "zod";
import * as mock from "../mock/api.js";
import { isMock } from "./mode.js";

const verifierBase = () => {
  const q = new URLSearchParams(location.search).get("verifier");
  const env = import.meta.env;
  return `${location.protocol}//${q ?? `${env.VITE_VERIFIER_HOST ?? location.hostname}:${env.VITE_VERIFIER_PORT ?? "7404"}`}`;
};

const reportSchema = z.object({
  record: z
    .object({
      task_id: z.string(),
      attempt: z.number(),
      verdict: z.enum(["RELEASE", "WITHHOLD"]),
      exit_code: z.number(),
      verifier_package_sha256: z.string(),
      delivery_sha256: z.string(),
      verifier_sig: z.string(),
      checks: z.array(z.object({ id: z.string(), status: z.enum(["PASS", "FAIL"]) })),
    })
    .passthrough(),
  outcome: z.enum(["PASS", "FAIL"]),
  code: z.string().nullable(),
  message: z.string(),
  sandbox: z.string(),
  log_tail: z.array(z.string()),
  verify_sh_sha256: z.string(),
  seconds: z.number(),
  v2: z
    .object({
      score: z.number().nullable().optional(),
      min_score: z.number().nullable().optional(),
      profile: z.string().nullable().optional(),
    })
    .optional(),
});

const taskSchema = z.object({
  task_id: z.string(),
  payment_hash: z.string(),
  released: z.boolean(),
  reports: z.array(reportSchema),
});
export type VerifierTaskView = z.infer<typeof taskSchema>;

export async function fetchVerifierTasks(): Promise<VerifierTaskView[]> {
  const r = await fetch(`${verifierBase()}/v0/verdicts`);
  if (!r.ok) throw new Error("verifier not reachable");
  return z.object({ tasks: z.array(taskSchema) }).parse(await r.json()).tasks;
}

export interface PackageStats {
  package_sha256: string;
  package_id: string;
  format: number;
  profile: string | null;
  runs: number;
  pass_rate: number;
  mean_score: number | null;
  median_duration_ms: number | null;
  determinism_rate: number | null;
  self_check_agreement: number | null;
  checks: { id: string; runs: number; fail_rate: number }[];
  withhold_codes: Record<string, number>;
}

const rate = z.number().min(0).max(1);
const packageStatsSchema = z.object({
  package_sha256: z.string(),
  package_id: z.string(),
  format: z.number().default(1),
  profile: z.string().nullable().default(null),
  runs: z.number().int().min(0),
  pass_rate: rate,
  mean_score: z.number().nullable().default(null),
  median_duration_ms: z.number().nullable().default(null),
  determinism_rate: rate.nullable().default(null),
  self_check_agreement: rate.nullable().default(null),
  checks: z.array(z.object({ id: z.string(), runs: z.number(), fail_rate: rate })).default([]),
  withhold_codes: z.record(z.string(), z.number()).default({}),
});

/** Rows that do not parse are skipped with a console warning; unknown fields are ignored. */
export function parseStats(body: unknown): PackageStats[] {
  const rows = z.object({ packages: z.array(z.unknown()) }).parse(body).packages;
  const out: PackageStats[] = [];
  for (const row of rows) {
    const r = packageStatsSchema.safeParse(row);
    if (r.success) out.push(r.data);
    else console.warn("stats: skipped a malformed package row", r.error.issues[0]);
  }
  return out;
}

export async function fetchVerifierStats(): Promise<PackageStats[]> {
  if (isMock()) return mock.fetchVerifierStats();
  const r = await fetch(`${verifierBase()}/v0/stats`);
  if (!r.ok) throw new Error("verifier not reachable");
  return parseStats(await r.json());
}
