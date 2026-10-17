// Deterministic, I/O-free checks on a mandate, shared by the Principal signer (before signing) and the engine
// (before registering), so both apply the same rules. Fail closed: anything unparsable is a violation.
import { cmpAmount, parseAmount } from "@verdict/protocol";

export const DEFAULT_MAX_ROOT_AMOUNT = "500.00";
export const DEFAULT_MAX_ROOT_EXPIRY_SECONDS = 86_400;
export const TUSD_PRECISION = 2;

export interface HardLimits {
  /** Decimal string, same precision as the asset. */
  max_root_amount: string;
  max_root_expiry_seconds: number;
}

export function hardLimits(env: NodeJS.ProcessEnv = process.env): HardLimits {
  const amt = env.MAX_ROOT_AMOUNT ?? DEFAULT_MAX_ROOT_AMOUNT;
  if (!/^\d+(\.\d+)?$/.test(amt)) throw new Error("MAX_ROOT_AMOUNT must be a decimal amount");
  const raw = env.MAX_ROOT_EXPIRY_SECONDS;
  const secs = raw === undefined || raw === "" ? DEFAULT_MAX_ROOT_EXPIRY_SECONDS : Number(raw);
  if (!Number.isSafeInteger(secs) || secs <= 0)
    throw new Error("MAX_ROOT_EXPIRY_SECONDS must be a positive integer");
  return { max_root_amount: amt, max_root_expiry_seconds: secs };
}

/** Minor-unit amounts mentioned in the user's text ("1.20", "8"). Used for the ADR-019 cross-check. */
export function amountsInText(text: string, precision = TUSD_PRECISION): Set<bigint> {
  const out = new Set<bigint>();
  for (const m of text.matchAll(/(\d+)(?:[.,](\d{1,2}))?/g)) {
    const whole = m[1] ?? "0";
    const frac = (m[2] ?? "").padEnd(precision, "0");
    out.add(BigInt(whole) * 10n ** BigInt(precision) + BigInt(frac || "0"));
  }
  return out;
}

export interface AmountFlag {
  readonly code: "AMOUNT_NOT_IN_GOAL";
  readonly amount: string;
}

/** Amounts of the mandate (decimal strings) that the goal text never mentions. Empty means not flagged. */
export function amountFlags(
  goal: string,
  root: { max_total: string; max_per_task: string },
  precision = TUSD_PRECISION,
): AmountFlag[] {
  const seen = amountsInText(goal, precision);
  const flags: AmountFlag[] = [];
  for (const amount of new Set([root.max_total, root.max_per_task])) {
    let minor: bigint | undefined;
    try {
      minor = parseAmount(amount, precision);
    } catch {
      minor = undefined;
    }
    if (minor === undefined || !seen.has(minor)) flags.push({ code: "AMOUNT_NOT_IN_GOAL", amount });
  }
  return flags;
}

export type RootLimitViolation =
  | { kind: "TOTAL_OVER_LIMIT"; amount: string; max: string }
  | { kind: "PER_TASK_OVER_LIMIT"; amount: string; max: string }
  | { kind: "EXPIRED"; expires_at: string }
  | { kind: "EXPIRY_TOO_FAR"; expires_at: string; latest: string; seconds: number }
  | { kind: "UNREADABLE" };

/** First hard-limit violation of a root's amounts and expiry, or undefined. */
export function rootLimitViolation(
  root: { max_total: string; max_per_task: string; expires_at: string },
  limits: HardLimits,
  precision: number,
  now: Date,
): RootLimitViolation | undefined {
  try {
    const max = parseAmount(limits.max_root_amount, precision);
    if (cmpAmount(parseAmount(root.max_total, precision), max) > 0)
      return { kind: "TOTAL_OVER_LIMIT", amount: root.max_total, max: limits.max_root_amount };
    if (cmpAmount(parseAmount(root.max_per_task, precision), max) > 0)
      return {
        kind: "PER_TASK_OVER_LIMIT",
        amount: root.max_per_task,
        max: limits.max_root_amount,
      };
    const exp = Date.parse(root.expires_at);
    if (Number.isNaN(exp)) return { kind: "UNREADABLE" };
    if (exp <= now.getTime()) return { kind: "EXPIRED", expires_at: root.expires_at };
    const latest = new Date(now.getTime() + limits.max_root_expiry_seconds * 1000).toISOString();
    if (exp > Date.parse(latest))
      return {
        kind: "EXPIRY_TOO_FAR",
        expires_at: root.expires_at,
        latest,
        seconds: limits.max_root_expiry_seconds,
      };
    return undefined;
  } catch {
    return { kind: "UNREADABLE" };
  }
}
