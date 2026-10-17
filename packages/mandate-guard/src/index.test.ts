import { describe, expect, it } from "vitest";
import { amountFlags, amountsInText, rootLimitViolation } from "./index.js";

const limits = { max_root_amount: "500.00", max_root_expiry_seconds: 3600 };
const now = new Date("2026-10-10T10:00:00Z");

describe("mandate-guard", () => {
  it("reads amounts from text", () => {
    expect([...amountsInText("pay 1.20 or 8")]).toEqual([120n, 800n]);
  });
  it("flags amounts the goal never mentions", () => {
    expect(
      amountFlags("budget 10.00 per task 2.00", { max_total: "10.00", max_per_task: "2.00" }),
    ).toEqual([]);
    expect(amountFlags("budget 10.00", { max_total: "10.00", max_per_task: "99.00" })).toEqual([
      { code: "AMOUNT_NOT_IN_GOAL", amount: "99.00" },
    ]);
    expect(amountFlags("x", { max_total: "oops", max_per_task: "1" })).toHaveLength(2);
  });
  it("applies hard limits and fails closed", () => {
    const ok = { max_total: "10.00", max_per_task: "2.00", expires_at: "2026-10-10T10:30:00Z" };
    expect(rootLimitViolation(ok, limits, 2, now)).toBeUndefined();
    expect(rootLimitViolation({ ...ok, max_total: "501.00" }, limits, 2, now)?.kind).toBe(
      "TOTAL_OVER_LIMIT",
    );
    expect(rootLimitViolation({ ...ok, max_per_task: "501.00" }, limits, 2, now)?.kind).toBe(
      "PER_TASK_OVER_LIMIT",
    );
    expect(
      rootLimitViolation({ ...ok, expires_at: "2026-10-10T09:00:00Z" }, limits, 2, now)?.kind,
    ).toBe("EXPIRED");
    expect(
      rootLimitViolation({ ...ok, expires_at: "2026-10-11T10:00:00Z" }, limits, 2, now)?.kind,
    ).toBe("EXPIRY_TOO_FAR");
    expect(rootLimitViolation({ ...ok, expires_at: "nope" }, limits, 2, now)?.kind).toBe(
      "UNREADABLE",
    );
    expect(rootLimitViolation({ ...ok, max_total: "abc" }, limits, 2, now)?.kind).toBe(
      "UNREADABLE",
    );
  });
});
