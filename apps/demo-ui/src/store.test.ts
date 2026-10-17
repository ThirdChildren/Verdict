import type { UiEvent } from "@verdict/protocol";
import { describe, expect, it } from "vitest";
import { MOCK_EVENTS } from "./mock/events.js";
import { type AppState, initialState, reduce } from "./store.js";

const run = (n: number): AppState => MOCK_EVENTS.slice(0, n).reduce(reduce, initialState);
const idx = (pred: (i: number) => boolean) => MOCK_EVENTS.findIndex((_e, i) => pred(i)) + 1;

describe("store reducer", () => {
  it("holds no client-side budget math", () => {
    const s = run(MOCK_EVENTS.length);
    expect(s).not.toHaveProperty("pendingReserved");
    expect(s).not.toHaveProperty("committedByHash");
  });
  it("BUDGET_UPDATED stores engine-reported amounts verbatim", () => {
    expect(run(1).budget).toBeNull();
    const withBudget = run(MOCK_EVENTS.length);
    expect(withBudget.budget).toMatchObject({
      remaining: "3.80",
      reserved: "0.00",
      committed: "1.20",
    });
    const mid = MOCK_EVENTS.findIndex(
      (e) => e.type === "BUDGET_UPDATED" && e.data.reserved === "1.20",
    );
    expect(run(mid + 1).budget?.reserved).toBe("1.20");
  });
  it("sets precision from the root mandate", () => {
    expect(run(1).precision).toBe(2);
  });
  it("ignores replayed (old seq) events", () => {
    const s = run(3);
    expect(reduce(s, MOCK_EVENTS[0] as UiEvent)).toBe(s);
  });
  it("records blocks and ends the walkthrough with the CLAIMED task", () => {
    const s = run(MOCK_EVENTS.length);
    expect(s.blocks[0]?.code).toBe("AMOUNT_EXCEEDS_PER_TASK");
    expect(s.verdicts).toHaveLength(2);
    expect(idx(() => true)).toBeGreaterThan(0);
  });
  it("PAYMENT_CONFIRMING shows until the wallet reports a status for that payment", () => {
    const hash = "a".repeat(64);
    const task_id = "task_0123456789abcdef";
    const waiting = reduce(initialState, {
      seq: 0,
      at: "2026-10-18T14:45:00Z",
      type: "PAYMENT_CONFIRMING",
      data: { task_id, payment_hash: hash },
    });
    expect(waiting.confirming).toEqual([hash]);
    const done = reduce(waiting, {
      seq: 1,
      at: "2026-10-18T14:45:05Z",
      type: "PAYMENT_STATUS",
      data: { task_id, payment_hash: hash, status: "Pending" },
    });
    expect(done.confirming).toEqual([]);
  });
  it("keeps the root budget separate from child budgets", () => {
    const s = run(MOCK_EVENTS.length);
    const child = reduce(s, {
      seq: 999,
      at: "2026-10-18T16:00:00Z",
      type: "BUDGET_UPDATED",
      data: {
        cap_id: "cap_aaaaaaaaaaaaaaaa",
        remaining: "0.10",
        reserved: "0.00",
        committed: "0.00",
      },
    });
    expect(child.budget).toEqual(s.budget);
    expect(child.childBudgets.cap_aaaaaaaaaaaaaaaa?.remaining).toBe("0.10");
  });
  it("keeps per-task rows with amount and a timestamped payment history", () => {
    const s = run(MOCK_EVENTS.length);
    const t = s.tasks.task_0123456789abcdef;
    expect(t?.amount).toBe("1.20");
    expect(t?.payHistory.map((h) => h.status)).toEqual(["Pending", "Claimable", "Settled"]);
    expect(t?.payHistory.every((h) => h.at.endsWith("Z"))).toBe(true);
  });
  it("records Failed and does not duplicate repeated statuses", () => {
    const task_id = "task_0123456789abcdef";
    const payment_hash = "a".repeat(64);
    const ev = (seq: number, status: "Pending" | "Failed"): UiEvent => ({
      seq,
      at: `2026-10-18T14:45:0${seq}Z`,
      type: "PAYMENT_STATUS",
      data: { task_id, payment_hash, status },
    });
    const s = [ev(0, "Pending"), ev(1, "Pending"), ev(2, "Failed")].reduce(reduce, initialState);
    expect(s.tasks[task_id]?.payHistory).toEqual([
      { status: "Pending", at: "2026-10-18T14:45:00Z" },
      { status: "Failed", at: "2026-10-18T14:45:02Z" },
    ]);
  });
});
