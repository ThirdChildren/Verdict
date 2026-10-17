// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MOCK_EVENTS } from "../mock/events.js";
import { initialState, reduce } from "../store.js";
import { BudgetMeter, segmentWidths } from "./BudgetMeter.js";

afterEach(cleanup);
const upto = (n: number) => MOCK_EVENTS.slice(0, n).reduce(reduce, initialState);

describe("BudgetMeter", () => {
  it("says there is no mandate before one exists", () => {
    render(<BudgetMeter state={initialState} />);
    expect(screen.queryByText(/no mandate yet/i)).toBeNull();
  });
  it("labels paid, locked and left with the engine's numbers (words, not colour alone)", () => {
    const s = MOCK_EVENTS.reduce(reduce, initialState);
    render(<BudgetMeter state={s} />);
    const group = screen.getByRole("region", { name: "Budget" });
    expect(group.textContent).toMatch(/Paid\s*1\.20/);
    expect(group.textContent).toMatch(/Locked\s*0\.00/);
    expect(group.textContent).toMatch(/Left\s*3\.80/);
    expect(group.textContent).toContain("of 5.00 tUSD");
    expect(screen.getByRole("img").getAttribute("aria-label")).toContain("Paid 1.20");
  });
  it("shows locked funds while the escrow is held", () => {
    const i = MOCK_EVENTS.findIndex((e) => e.type === "PAYMENT_STATUS");
    render(<BudgetMeter state={upto(i + 1)} />);
    expect(screen.getByRole("region", { name: "Budget" }).textContent).toMatch(/Locked\s*1\.20/);
  });
  it("segment widths add up to 100 when the budget is known", () => {
    const w = segmentWidths(
      { cap_id: "x", remaining: "3.80", reserved: "1.20", committed: "0.00" },
      2,
    );
    expect((w.committed ?? 0) + (w.reserved ?? 0) + (w.remaining ?? 0)).toBeCloseTo(100, 1);
  });
});
