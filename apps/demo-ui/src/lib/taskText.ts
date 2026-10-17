import { fromMinor, toMinor } from "./money.js";

/** Default task description, as the buyer agent understands it. */
export const DEFAULT_TASK_DESCRIPTION = "convert a CSV file into JSON";
const DEFAULT_TASK_AMOUNT_MINOR = 120n; // 1.20 tUSD at precision 2; scaled below
export const AMOUNT_STEP = "0.10";

function minorOrNull(v: string, precision: number): bigint | null {
  try {
    return toMinor(v, precision);
  } catch {
    return null;
  }
}

/** Default amount of a task: min(1.20, remaining), formatted with the asset precision. */
export function defaultTaskAmount(remaining: string, precision: number): string {
  const rem = minorOrNull(remaining, precision) ?? 0n;
  const def = DEFAULT_TASK_AMOUNT_MINOR * 10n ** BigInt(Math.max(precision - 2, 0));
  return fromMinor(rem < def ? rem : def, precision);
}

/** Null when the amount is usable: a positive decimal that is not above what the engine reports as remaining. */
export function amountProblem(amount: string, remaining: string, precision: number): string | null {
  const a = minorOrNull(amount, precision);
  const rem = minorOrNull(remaining, precision) ?? 0n;
  if (a === null || a <= 0n) return "Enter an amount above 0.";
  if (a > rem) return `The mandate has only ${remaining} tUSD left. Enter ${remaining} or less.`;
  return null;
}

/** The text sent to the buyer agent. It never reuses the mandate's own wording (and its ceiling). */
export function composeTaskGoal(amount: string, worker: string, description: string): string {
  return `Pay ${amount} tUSD to ${worker} to ${description.trim()}`;
}
