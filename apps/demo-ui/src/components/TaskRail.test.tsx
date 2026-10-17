// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chipFor, railRows } from "../lib/view.js";
import { MOCK_EVENTS } from "../mock/events.js";
import { initialState, reduce, useStore } from "../store.js";
import { neighbour, TaskRail } from "./TaskRail.js";

class RO {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= RO;
afterEach(cleanup);
beforeEach(() => useStore.setState({ ...initialState }));

const all = MOCK_EVENTS.reduce(reduce, initialState);

describe("task rail", () => {
  it("lists tasks and blocked attempts, newest on top, numbered oldest first", () => {
    const rows = railRows(all);
    expect(rows.map((r) => [r.n, r.kind, r.chip])).toEqual([
      [2, "block", "Blocked"],
      [1, "task", "Paid"],
    ]);
    expect(rows[0]?.amount).toBe("50.00");
  });
  it("auto-selects the newest task, then the block when one arrives", () => {
    const task = MOCK_EVENTS.findIndex((e) => e.type === "TASK_STATE");
    expect(MOCK_EVENTS.slice(0, task + 1).reduce(reduce, initialState).selected).toBe(
      "task_0123456789abcdef",
    );
    expect(all.selected).toMatch(/^block:/);
  });
  it("maps every task state to one of the seven chips", () => {
    expect(chipFor("ESCROW_LOCKED")).toBe("Locked");
    expect(chipFor("DELIVERED")).toBe("Verifying");
    expect(chipFor("VERDICT_WITHHOLD")).toBe("Refund pending");
    expect(chipFor("REFUNDED")).toBe("Refunded");
    expect(chipFor("REFUNDED")).toBe("Refunded");
    expect(chipFor("EXPIRED")).toBe("Expired");
    expect(chipFor("OFFERED")).toBe("Working");
  });
  it("renders a button per row with word chips and selects on click", async () => {
    useStore.setState({ ...all });
    render(
      <TaskRail
        state={useStore.getState()}
        descriptions={{ task_0123456789abcdef: "Convert a CSV file into JSON" }}
        newTask={<button type="button">New task</button>}
      />,
    );
    expect(screen.getByText("Convert a CSV file into JSON")).toBeTruthy();
    expect(screen.getByText("Blocked")).toBeTruthy();
    expect(screen.getByText("Paid")).toBeTruthy();
    const taskBtn = screen.getAllByRole("button").find((b) => b.textContent?.includes("Paid"));
    expect(taskBtn).toBeTruthy();
    await userEvent.click(taskBtn as HTMLElement);
    expect(useStore.getState().selected).toBe("task_0123456789abcdef");
  });
  it("shows an empty state", () => {
    render(<TaskRail state={initialState} descriptions={{}} newTask={null} />);
    expect(screen.getByText(/No tasks yet/)).toBeTruthy();
  });
  it("neighbour moves down and up the list and clamps", () => {
    const rows = railRows(all);
    expect(neighbour(rows, rows[0]?.key ?? null, 1)).toBe(rows[1]?.key);
    expect(neighbour(rows, rows[1]?.key ?? null, 1)).toBe(rows[1]?.key);
    expect(neighbour([], null, 1)).toBeNull();
  });
});
