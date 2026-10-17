export const WARN_BELOW_TPS = 30;
export const FAIL_BELOW_TPS = 15;

export type SpeedVerdict = "ok" | "warn" | "fail";

/** Preflight rule: under 30 tok/s the GPU or power profile is probably wrong, under 15 the demo cannot finish in time. */
export function classifyTps(tps: number | null): SpeedVerdict {
  if (tps === null || Number.isNaN(tps) || tps < FAIL_BELOW_TPS) return "fail";
  return tps < WARN_BELOW_TPS ? "warn" : "ok";
}
