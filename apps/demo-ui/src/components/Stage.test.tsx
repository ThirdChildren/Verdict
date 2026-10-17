// @vitest-environment jsdom

import { cleanup, screen, within } from "@testing-library/react";
import type { TaskState, UiEvent } from "@verdict/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { isWorkerStopped, WORKER_STOPPED_AFTER_MS } from "../lib/stopped.js";
import { railRows, stepViews } from "../lib/view.js";
import { MOCK_EVENTS } from "../mock/events.js";
import { type AppState, initialState, reduce } from "../store.js";
import { renderWithProviders as render } from "../test-utils.js";
import { HELD_AFTER_FAIL_MS, isHeld, Stage } from "./Stage.js";
import { VerifyPanel } from "./StepPanels.js";

afterEach(cleanup);
const M = { engine: "E", worker: "W", verifier: "V" };
const TASK = "task_0123456789abcdef";
const upto = (pred: (e: UiEvent) => boolean, extra: UiEvent[] = []): AppState => {
  const i = MOCK_EVENTS.findIndex(pred);
  return [...MOCK_EVENTS.slice(0, i + 1), ...extra].reduce(reduce, initialState);
};
const atState = (s: TaskState) => (e: UiEvent) => e.type === "TASK_STATE" && e.data.state === s;
const last = (s: AppState) => {
  const t = s.tasks[TASK];
  if (!t) throw new Error("no task");
  return t;
};
const words = (s: AppState) => stepViews(last(s), M).map((v) => v.state);
const end = (s: TaskState, seq: number): UiEvent => ({
  seq,
  at: "2026-10-18T15:50:00Z",
  type: "TASK_STATE",
  data: { task_id: TASK, state: s },
});

describe("stage stepper model", () => {
  it("Authorized is active before the funds are locked", () => {
    expect(words(upto(atState("ACCEPTED")))).toEqual([
      "active",
      "pending",
      "pending",
      "pending",
      "pending",
    ]);
  });
  it("Work is active once the escrow is locked", () => {
    expect(words(upto(atState("ESCROW_LOCKED")))).toEqual([
      "done",
      "done",
      "active",
      "pending",
      "pending",
    ]);
  });
  it("a failed check marks Verify FAIL and leaves Settled waiting for the refund", () => {
    const s = upto(atState("VERDICT_WITHHOLD"));
    expect(words(s)).toEqual(["done", "done", "done", "failed", "active"]);
    expect(stepViews(last(s), M)[3]?.word).toBe("FAIL");
    expect(stepViews(last(s), M)[4]?.word).toBe("Waiting for refund");
    expect(stepViews(last(s), M)[2]?.machine).toBe("W · worker");
  });
  it("a claimed payment completes all five steps with timestamps", () => {
    const s = upto(atState("CLAIMED"));
    expect(words(s)).toEqual(["done", "done", "done", "done", "done"]);
    expect(stepViews(last(s), M).every((v) => v.at)).toBe(true);
  });
  it("refund and expiry end on a failed last step with its own label", () => {
    const refunded = upto(atState("ESCROW_LOCKED"), [end("REFUNDED", 900)]);
    expect(stepViews(last(refunded), M)[4]).toMatchObject({ label: "Refunded", state: "failed" });
    const expired = upto(atState("ESCROW_LOCKED"), [end("EXPIRED", 900)]);
    expect(stepViews(last(expired), M)[4]).toMatchObject({ label: "Expired", state: "failed" });
  });
});

describe("Stage", () => {
  it("shows the work panel with attempt counter and tokens/s while working", () => {
    const s = upto(atState("ESCROW_LOCKED"));
    render(
      <Stage
        state={s}
        live={{
          key: `${TASK}:1`,
          attempt: 1,
          thinking: "",
          output: '[{"a":1}]',
          tokens: 120,
          tps: 42.5,
          done: false,
        }}
      />,
    );
    expect(screen.getByText("attempt 1/3")).toBeTruthy();
    expect(screen.getByText("42.5 tok/s")).toBeTruthy();
    expect(screen.getByRole("log").textContent).toContain("[{");
  });
  it("shows a big PASS without raw hashes on the stage, and FAIL for a withheld verdict", () => {
    const s = upto(atState("VERDICT_RELEASE"));
    const [fail, pass] = s.verdicts;
    render(<VerifyPanel taskId={TASK} verdict={pass ?? null} />);
    expect(screen.getByText("PASS")).toBeTruthy();
    expect(screen.queryByText(/3333333333/)).toBeNull();
    cleanup();
    render(<VerifyPanel taskId={TASK} verdict={fail ?? null} />);
    expect(screen.getByText("FAIL")).toBeTruthy();
  });
  it("lists the five steps while settling", () => {
    render(<Stage state={upto(atState("VERDICT_RELEASE"))} live={null} />);
    const stepper = screen.getByRole("list", { name: "Progress" });
    expect(within(stepper).getAllByRole("listitem")).toHaveLength(5);
    expect(screen.getAllByText("Settled").length).toBeGreaterThan(0);
  });
  it("renders every step with its state word", () => {
    render(<Stage state={upto(atState("ESCROW_LOCKED"))} live={null} />);
    expect(screen.getAllByText("Done")).toHaveLength(2);
    expect(screen.getByText("Now")).toBeTruthy();
    expect(screen.getAllByText("Waiting")).toHaveLength(2);
  });
});

describe("block ring rule after a FAIL", () => {
  const failAt = "2026-10-18T15:50:00Z";
  const t0 = Date.parse(failAt);
  it("shows only once the payment is held more than 10 s after the FAIL verdict", () => {
    const task = { state: "VERDICT_WITHHOLD", failAt };
    expect(isHeld(task, t0 + HELD_AFTER_FAIL_MS)).toBe(false);
    expect(isHeld(task, t0 + HELD_AFTER_FAIL_MS + 1)).toBe(true);
  });
  it("never shows after a refund or without a FAIL verdict", () => {
    expect(isHeld({ state: "REFUNDED", failAt }, t0 + 60_000)).toBe(false);
    expect(isHeld({ state: "VERDICT_WITHHOLD" }, t0 + 60_000)).toBe(false);
  });
  it("records failAt on the first FAIL only and keeps Verify FAIL after the refund", () => {
    const s = upto(atState("VERDICT_WITHHOLD"), [end("REFUNDED", 900)]);
    expect(last(s).failAt).toBeDefined();
    expect(stepViews(last(s), M)[3]?.word).toBe("FAIL");
  });
});

describe("worker stopped responding", () => {
  const locked = upto(atState("ESCROW_LOCKED"));
  const lockAt = Date.parse(last(locked).stepAt[2] ?? "");
  it("fires only after the timeout since the lock, and only while locked", () => {
    const t = last(locked);
    expect(isWorkerStopped(t, lockAt + WORKER_STOPPED_AFTER_MS)).toBe(false);
    expect(isWorkerStopped(t, lockAt + WORKER_STOPPED_AFTER_MS + 1)).toBe(true);
    expect(isWorkerStopped(t, lockAt + 600_000, true)).toBe(false); // tokens are streaming
    const delivered = last(upto(atState("DELIVERED")));
    expect(isWorkerStopped(delivered, lockAt + 600_000)).toBe(false);
  });
  it("accepts a backend worker_status hint", () => {
    const t = { ...last(locked), workerStopped: true };
    expect(isWorkerStopped(t, lockAt)).toBe(true);
    expect(isWorkerStopped({ ...t, workerStopped: false }, lockAt + 600_000)).toBe(false);
  });
  it("marks Work stuck, Verify skipped, Settle waiting, and the rail chip Refund pending", () => {
    const v = stepViews(last(locked), M, true);
    expect(v.map((x) => x.word)).toEqual([
      undefined,
      undefined,
      "Worker stopped responding",
      "Skipped — nothing delivered",
      "Waiting for refund",
    ]);
    expect(v[3]?.state).toBe("skipped");
    expect(railRows(locked, {}, new Set([TASK]))[0]?.chip).toBe("Refund pending");
    expect(railRows(locked)[0]?.chip).toBe("Locked");
  });
  it("shows the one-sentence caption and no verdict on the stage", () => {
    const old = {
      ...locked,
      tasks: {
        [TASK]: {
          ...last(locked),
          stepAt: {
            0: "2020-01-01T00:00:00Z",
            1: "2020-01-01T00:00:00Z",
            2: "2020-01-01T00:00:00Z",
          },
        },
      },
      selected: TASK,
    };
    render(<Stage state={old} live={null} />);
    expect(
      screen.getByText(
        "The worker vanished. The money stays locked until the escrow deadline, then comes back to you.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("PASS")).toBeNull();
    expect(screen.queryByText("FAIL")).toBeNull();
  });
});
