import { describe, expect, it } from "vitest";
import {
  exceedsAvailable,
  parseCeiling,
  presetsFor,
  sliderBounds,
  withCeiling,
} from "./ceiling.js";

describe("parseCeiling", () => {
  it("reads positive amounts as minor units", () => {
    expect(parseCeiling("5", 2)).toBe(500n);
    expect(parseCeiling("5.00", 2)).toBe(500n);
    expect(parseCeiling(" 0.07 ", 2)).toBe(7n);
  });
  it("rejects empty, zero, negative, too many decimals and non-numbers", () => {
    for (const bad of ["", "0", "0.00", "-1", "1.234", "abc", "1e3", "1,5", "."])
      expect(parseCeiling(bad, 2)).toBeNull();
  });
});

describe("presetsFor", () => {
  it("multiplies the per-task limit with bigint math", () => {
    expect(presetsFor("1.20", 2).map((p) => [p.tasks, p.total, p.label])).toEqual([
      [1, "1.20", "1 task of 1.20"],
      [3, "3.60", "3 tasks of 1.20"],
      [5, "6.00", "5 tasks of 1.20"],
    ]);
  });
  it("gives none when the per-task limit is unreadable", () => {
    expect(presetsFor("", 2)).toEqual([]);
  });
});

describe("exceedsAvailable", () => {
  it("warns only above the available funds", () => {
    expect(exceedsAvailable(4880n, "48.80", 2)).toBe(false);
    expect(exceedsAvailable(4881n, "48.80", 2)).toBe(true);
    expect(exceedsAvailable(1n, "0.00", 2)).toBe(true);
  });
  it("never warns when the funds are unknown", () => {
    expect(exceedsAvailable(10n ** 9n, null, 2)).toBe(false);
  });
});

describe("sliderBounds", () => {
  it("spans 0..available with a whole-tUSD step", () => {
    const b = sliderBounds("48.80", 500n, 2);
    expect(b.max).toBe(4880);
    expect(b.step).toBe(100);
  });
  it("uses the smallest step when little is available, and 0 when nothing is", () => {
    expect(sliderBounds("1.50", 500n, 2).step).toBe(1);
    expect(sliderBounds("0.00", 500n, 2).max).toBe(0);
  });
  it("falls back to the drafted ceiling when the funds are unknown", () => {
    expect(sliderBounds(null, 500n, 2).max).toBe(500);
  });
  it("pins the thumb at the maximum when the ceiling is above it, and never exceeds it", () => {
    const b = sliderBounds("10.00", 500n, 2);
    expect(b.position(2500n)).toBe(1000);
    expect(b.position(300n)).toBe(300);
    expect(b.position(null)).toBe(0);
  });
});

describe("withCeiling", () => {
  it("sets the total and keeps the per-task limit when it fits", () => {
    expect(withCeiling({ max_total: "5.00", max_per_task: "2.00" }, 1000n, 2)).toEqual({
      max_total: "10.00",
      max_per_task: "2.00",
    });
  });
  it("lowers the per-task limit to the ceiling when the ceiling is smaller", () => {
    expect(withCeiling({ max_total: "5.00", max_per_task: "2.00" }, 150n, 2)).toEqual({
      max_total: "1.50",
      max_per_task: "1.50",
    });
  });
  it("keeps other fields", () => {
    const r = withCeiling({ max_total: "5.00", max_per_task: "2.00", expires_at: "x" }, 300n, 2);
    expect(r.expires_at).toBe("x");
  });
});
