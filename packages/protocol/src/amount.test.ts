import { describe, expect, it } from "vitest";
import {
  addAmount,
  amountString,
  cmpAmount,
  formatAmount,
  parseAmount,
  subAmount,
} from "./index.js";

describe("amounts", () => {
  it("parses and formats", () => {
    expect(parseAmount("1.20", 2)).toBe(120n);
    expect(parseAmount("0.00", 2)).toBe(0n);
    expect(parseAmount("1234.05", 2)).toBe(123405n);
    expect(formatAmount(120n, 2)).toBe("1.20");
    expect(formatAmount(5n, 2)).toBe("0.05");
    expect(formatAmount(0n, 2)).toBe("0.00");
    expect(formatAmount(7n, 0)).toBe("7");
    expect(parseAmount("12", 0)).toBe(12n);
    expect(parseAmount("1.234", 3)).toBe(1234n);
  });
  it.each([
    "1",
    "1.2",
    "1.200",
    "-1.00",
    "+1.00",
    "1e2",
    "1.0e1",
    "01.00",
    ".50",
    "1.",
    " 1.00",
    "1.00 ",
    "NaN",
    "Infinity",
    "0x10",
    "1,00",
    "",
  ])("rejects %j", (s) => {
    expect(() => parseAmount(s, 2)).toThrow();
  });
  it("rejects non-strings and floats", () => {
    expect(() => parseAmount(1.2, 2)).toThrow();
    expect(() => parseAmount(null, 2)).toThrow();
    expect(() => parseAmount(120n, 2)).toThrow();
    expect(() => formatAmount(1.5 as unknown as bigint, 2)).toThrow();
    expect(() => formatAmount(-1n, 2)).toThrow();
  });
  it("requires an explicit, bounded precision", () => {
    expect(() => (parseAmount as (s: string) => bigint)("1.20")).toThrow();
    expect(() => (formatAmount as (m: bigint) => string)(1n)).toThrow();
    expect(() => parseAmount("1.20", 19)).toThrow();
    expect(parseAmount(`1.${"0".repeat(17)}1`, 18)).toBe(1000000000000000001n);
  });
  it("wire schema caps fraction digits at 18", () => {
    expect(amountString.safeParse("1.123456789012345678").success).toBe(true);
    expect(amountString.safeParse("1.1234567890123456789").success).toBe(false);
  });
  it("arithmetic", () => {
    expect(addAmount(120n, 80n)).toBe(200n);
    expect(subAmount(200n, 80n)).toBe(120n);
    expect(() => subAmount(1n, 2n)).toThrow();
    expect(() => addAmount(-1n, 2n)).toThrow();
    expect(cmpAmount(1n, 2n)).toBe(-1);
    expect(cmpAmount(2n, 2n)).toBe(0);
    expect(cmpAmount(3n, 2n)).toBe(1);
  });
  it("round-trips", () => {
    for (const n of [0n, 1n, 99n, 100n, 123456789012345678901234567890n])
      expect(parseAmount(formatAmount(n, 2), 2)).toBe(n);
  });
});
