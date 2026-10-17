/** Max fraction digits anywhere in the protocol (wire schema and helpers). Precision is always passed explicitly (config TUSD_PRECISION). */
export const MAX_AMOUNT_PRECISION = 18;

export class AmountError extends Error {
  override readonly name = "AmountError";
}

function checkPrecision(precision: number): void {
  if (!Number.isInteger(precision) || precision < 0 || precision > MAX_AMOUNT_PRECISION) {
    throw new AmountError(`Invalid precision ${precision}`);
  }
}

/** Parse a wire decimal string ("1.20") to bigint minor units. Exactly `precision` fraction digits; no sign, float, exponent, whitespace. */
export function parseAmount(s: unknown, precision: number): bigint {
  checkPrecision(precision);
  if (typeof s !== "string") throw new AmountError("Amount must be a decimal string");
  const re =
    precision === 0 ? /^(0|[1-9][0-9]*)$/ : new RegExp(`^(0|[1-9][0-9]*)\\.([0-9]{${precision}})$`);
  const m = re.exec(s);
  if (!m)
    throw new AmountError(
      `Invalid amount "${s}": expected a decimal with exactly ${precision} fraction digits`,
    );
  return BigInt(`${m[1]}${m[2] ?? ""}`);
}

export function formatAmount(minor: bigint, precision: number): string {
  checkPrecision(precision);
  if (typeof minor !== "bigint") throw new AmountError("Amount must be a bigint");
  if (minor < 0n) throw new AmountError("Amount cannot be negative");
  if (precision === 0) return minor.toString();
  const s = minor.toString().padStart(precision + 1, "0");
  return `${s.slice(0, -precision)}.${s.slice(-precision)}`;
}

export function addAmount(a: bigint, b: bigint): bigint {
  const r = a + b;
  if (a < 0n || b < 0n) throw new AmountError("Amount cannot be negative");
  return r;
}

/** Throws if the result would be negative. */
export function subAmount(a: bigint, b: bigint): bigint {
  if (a < 0n || b < 0n) throw new AmountError("Amount cannot be negative");
  if (b > a) throw new AmountError("Subtraction would go below zero");
  return a - b;
}

export function cmpAmount(a: bigint, b: bigint): -1 | 0 | 1 {
  return a < b ? -1 : a > b ? 1 : 0;
}
