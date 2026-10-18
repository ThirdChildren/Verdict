import type { UiEvent } from "@verdict/protocol";
import { describe, expect, it } from "vitest";
import { parseRetiredEvent } from "./lib/retired.js";
import { railRows } from "./lib/view.js";
import { MOCK_EVENTS } from "./mock/events.js";
import { type AppState, initialState, reduce, useStore } from "./store.js";

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

describe("MANDATE_RETIRED", () => {
  const frame = {
    type: "MANDATE_RETIRED",
    cap_hash: "cap_2222222222222222",
    retired: ["cap_0123456789abcdef"],
    reason: "The previous mandate was retired.",
  };
  it("parses the UI-only shape and the earlier draft shape, nothing else", () => {
    expect(parseRetiredEvent(JSON.stringify(frame))).toMatchObject({ retired: frame.retired });
    expect(
      parseRetiredEvent({ type: "MANDATE_RETIRED", cap_id: "a", replaced_by: "b", message: "m" }),
    ).toMatchObject({ cap_hash: "b", retired: ["a"], reason: "m" });
    expect(parseRetiredEvent({ type: "MANDATE_RETIRED" })).toBeNull();
    expect(parseRetiredEvent("not json")).toBeNull();
  });
  it("marks earlier tasks retired, keeps their state, and switches the budget to the new root", () => {
    useStore.getState().reset();
    const st = useStore.getState();
    for (const e of MOCK_EVENTS.slice(0, MOCK_EVENTS.length - 1)) st.apply(e);
    const before = railRows(useStore.getState());
    expect(before.every((r) => !r.retired)).toBe(true);
    const root = useStore.getState().root;
    if (!root) throw new Error("no root");
    const last = useStore.getState().lastSeq;
    st.retire({ ...frame, retired: [root.cap_id] });
    st.apply({
      ...(MOCK_EVENTS[0] as UiEvent),
      seq: last + 1,
      data: { ...root, cap_id: frame.cap_hash },
    } as UiEvent);
    const mid = useStore.getState();
    expect(mid.budget).toBeNull();
    st.apply({
      seq: last + 2,
      at: "2026-10-18T16:00:00Z",
      type: "BUDGET_UPDATED",
      data: { cap_id: frame.cap_hash, remaining: "5.00", reserved: "0.00", committed: "0.00" },
    });
    const after = useStore.getState();
    expect(after.retirements[0]?.retired).toEqual([root.cap_id]);
    expect(after.budget?.remaining).toBe("5.00");
    const rows = railRows(after).filter((r) => r.kind === "task");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.retired)).toBe(true);
    expect(rows.map((r) => r.chip)).toEqual(
      before.filter((r) => r.kind === "task").map((r) => r.chip),
    );
    useStore.getState().reset();
  });
});

describe("mock refund", () => {
  it("applies the failed payment, REFUNDED and the released budget so stage, rail and ledger agree", async () => {
    const { vi } = await import("vitest");
    const { mineUntilRefund } = await import("./mock/api.js");
    vi.useFakeTimers();
    useStore.getState().reset();
    const locked = MOCK_EVENTS.findIndex(
      (e) => e.type === "TASK_STATE" && e.data.state === "ESCROW_LOCKED",
    );
    for (const e of MOCK_EVENTS.slice(0, locked + 1)) useStore.getState().apply(e);
    const id = Object.keys(useStore.getState().tasks)[0] as string;
    expect(useStore.getState().budget?.reserved).toBe("1.20");
    await mineUntilRefund(id);
    await vi.runAllTimersAsync();
    const s = useStore.getState();
    expect(s.tasks[id]?.state).toBe("REFUNDED");
    expect(s.budget).toMatchObject({ reserved: "0.00", remaining: "5.00" });
    vi.useRealTimers();
    s.reset();
  });
});

describe("TASK_REFUSED", () => {
  it("is kept as a refusal without creating a task row", async () => {
    const { parseRefusedEvent } = await import("./lib/refused.js");
    const r = parseRefusedEvent(
      JSON.stringify({
        type: "TASK_REFUSED",
        reason: "not verifiable",
        task_types: ["csv2json-v1"],
      }),
    );
    expect(r?.task_types[0]?.id).toBe("csv2json-v1");
    if (!r) throw new Error("not parsed");
    useStore.getState().refuse(r);
    const s = useStore.getState();
    expect(s.refusals[0]?.reason).toBe("not verifiable");
    expect(railRows(s)).toHaveLength(0);
    useStore.getState().reset();
    expect(useStore.getState().refusals).toEqual([]);
  });
});

describe("TASK_TYPE_ADDED (E33)", () => {
  it("is parsed from the SSE payload and stored once per id, newest first", async () => {
    const { parseTypeAddedEvent } = await import("./lib/authoring.js");
    const ev = (id: string, title: string) =>
      JSON.stringify({
        type: "TASK_TYPE_ADDED",
        seq: 1,
        at: "2026-01-01T00:00:00Z",
        data: { id, title, package_sha256: "a".repeat(64) },
      });
    const a = parseTypeAddedEvent(ev("custom-sum-12345678", "Sum two numbers"));
    expect(a).toMatchObject({ id: "custom-sum-12345678", title: "Sum two numbers" });
    if (!a) throw new Error("not parsed");
    useStore.getState().addTaskType(a);
    useStore.getState().addTaskType({ ...a, id: "custom-other-87654321", title: "Other" });
    useStore.getState().addTaskType(a);
    expect(useStore.getState().addedTypes.map((t) => t.id)).toEqual([
      "custom-sum-12345678",
      "custom-other-87654321",
    ]);
    expect(parseTypeAddedEvent(JSON.stringify({ type: "BUDGET_UPDATED" }))).toBeNull();
    expect(parseTypeAddedEvent("not json")).toBeNull();
    useStore.getState().reset();
    expect(useStore.getState().addedTypes).toEqual([]);
  });
});
