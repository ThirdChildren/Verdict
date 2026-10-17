/** Default lock ceiling written into the demo Task Contract: 8 h. The real regtest lock is 25 200 s (42 blocks x 600 s). */
export const DEFAULT_MAX_LOCK_SECONDS = 28_800;
export const DEFAULT_SAFETY_MARGIN_SECONDS = 600;

export interface ContractLimits {
  max_lock_seconds: number;
  safety_margin_seconds: number;
}

function posInt(v: string | undefined, fallback: number, name: string): number {
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer`);
  return n;
}

/** MAX_LOCK_SECONDS and SAFETY_MARGIN_SECONDS (env) override the demo defaults. */
export function contractLimits(env: NodeJS.ProcessEnv = process.env): ContractLimits {
  return {
    max_lock_seconds: posInt(env.MAX_LOCK_SECONDS, DEFAULT_MAX_LOCK_SECONDS, "MAX_LOCK_SECONDS"),
    safety_margin_seconds: posInt(
      env.SAFETY_MARGIN_SECONDS,
      DEFAULT_SAFETY_MARGIN_SECONDS,
      "SAFETY_MARGIN_SECONDS",
    ),
  };
}
