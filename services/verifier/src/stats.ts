import type { RunReport, TaskEntry } from "./registry.js";

export interface PackageStats {
  package_sha256: string;
  package_id: string | null;
  format: 1 | 2;
  profile: string | null;
  runs: number;
  pass: number;
  pass_rate: number;
  mean_score: number | null;
  median_duration_ms: number | null;
  determinism_rate: number | null;
  self_check_agreement: number | null;
  checks: { id: string; runs: number; fail_rate: number }[];
  withhold_codes: Record<string, number>;
}

const round = (x: number, d: number): number => Math.round(x * 10 ** d) / 10 ** d;
const mean = (xs: number[]): number | null =>
  xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length;
function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

/** Per-package statistics, computed from the registry on request. Read-only; never signed, never sent anywhere. */
export function computeStats(tasks: TaskEntry[]): { packages: PackageStats[] } {
  const groups = new Map<string, RunReport[]>();
  for (const t of tasks) {
    const g = groups.get(t.package_sha256) ?? [];
    g.push(...t.reports);
    groups.set(t.package_sha256, g);
  }
  const packages: PackageStats[] = [];
  for (const [sha, reports] of groups) {
    if (reports.length === 0) continue;
    const v2 = reports.flatMap((r) => (r.v2 ? [r.v2] : []));
    const profile = v2.find((v) => v.profile !== null)?.profile ?? null;
    const det = v2.filter((v) => v.determinism !== "skipped");
    const sc = v2.filter((v) => v.self_check_exit_code !== undefined);
    const perCheck = new Map<string, { runs: number; fails: number }>();
    for (const v of v2)
      for (const c of v.checks) {
        const e = perCheck.get(c.id) ?? { runs: 0, fails: 0 };
        e.runs += 1;
        if (c.status === "fail") e.fails += 1;
        perCheck.set(c.id, e);
      }
    const codes: Record<string, number> = {};
    for (const r of reports) if (r.code) codes[r.code] = (codes[r.code] ?? 0) + 1;
    const pass = reports.filter((r) => r.outcome === "PASS").length;
    const mScore = mean(v2.flatMap((v) => (v.score === null ? [] : [v.score])));
    const med = median(reports.map((r) => r.v2?.duration_ms ?? Math.round(r.seconds * 1000)));
    packages.push({
      package_sha256: sha,
      package_id: v2.find((v) => v.package_id !== null)?.package_id ?? null,
      format: profile === null ? 1 : 2,
      profile,
      runs: reports.length,
      pass,
      pass_rate: round(pass / reports.length, 4),
      mean_score: mScore === null ? null : round(mScore, 2),
      median_duration_ms: med === null ? null : Math.round(med),
      determinism_rate:
        det.length === 0
          ? null
          : round(det.filter((v) => v.determinism === "match").length / det.length, 4),
      self_check_agreement:
        sc.length === 0 ? null : round(sc.filter((v) => v.self_check_agrees).length / sc.length, 4),
      checks: [...perCheck].map(([id, e]) => ({
        id,
        runs: e.runs,
        fail_rate: round(e.fails / e.runs, 4),
      })),
      withhold_codes: codes,
    });
  }
  return { packages };
}
