import { formatAmount, parseAmount } from "@verdict/protocol";

/** Number of fraction digits of a decimal string ("5.00" -> 2). Money stays a string/bigint, never a float. */
export function precisionOf(amount: string): number {
  return amount.split(".")[1]?.length ?? 0;
}

export function toMinor(amount: string, precision: number): bigint {
  return parseAmount(amount, precision);
}

export function fromMinor(minor: bigint, precision: number): string {
  return formatAmount(minor < 0n ? 0n : minor, precision);
}
