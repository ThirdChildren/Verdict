// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BLOCK_CODES, BLOCK_TEMPLATES } from "@verdict/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isFreshBlock, shouldToastBlock } from "../lib/notify.js";
import { BlockedScene } from "./BlockedScene.js";
import { BLOCK_NOTICE_BODY, BLOCK_NOTICE_TITLE, BlockNotice } from "./BlockNotice.js";
import { EmptyState } from "./EmptyState.js";

afterEach(cleanup);

const block = (code: (typeof BLOCK_CODES)[number], intent: unknown) => ({
  seq: 7,
  at: "2026-10-18T15:50:00Z",
  code,
  message: BLOCK_TEMPLATES[code].replace(/\{[a-z_]+\}/g, "X"),
  cap_id: null,
  intent,
});

describe("BlockedScene", () => {
  it("shows what the agent tried, the rule, and that nothing moved", () => {
    render(
      <BlockedScene
        block={block("COUNTERPARTY_NOT_ALLOWED", {
          amount: "9.00",
          counterparty: `eip191:0x${"c".repeat(40)}`,
          category: "gambling",
        })}
        names={{}}
      />,
    );
    expect(screen.getByText("9.00 tUSD")).toBeTruthy();
    expect(screen.getByText("gambling")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain(
      "Reason code: COUNTERPARTY_NOT_ALLOWED",
    );
    expect(screen.getByText("Nothing was signed. No funds moved.")).toBeTruthy();
  });
  it.each(BLOCK_CODES)("renders %s even when the intent is unusable", (code) => {
    render(<BlockedScene block={block(code, "garbage")} names={{}} />);
    expect(screen.queryByText("not stated")).toBeNull();
    expect(screen.queryByText("What the agent tried")).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain(`Reason code: ${code}`);
  });
});

describe("BlockedScene budget line", () => {
  it("says the budget is unchanged when the remaining amount is known", () => {
    render(
      <BlockedScene block={block("AMOUNT_EXCEEDS_PER_TASK", "m")} names={{}} remaining="3.80" />,
    );
    expect(screen.getByText("Your budget is unchanged: 3.80 tUSD left.")).toBeTruthy();
  });
});

describe("EmptyState and block notice", () => {
  it("offers one primary action", async () => {
    const onCreate = vi.fn();
    render(<EmptyState onCreate={onCreate} />);
    await userEvent.click(screen.getByRole("button", { name: "Create mandate" }));
    expect(onCreate).toHaveBeenCalled();
  });
  it("shows an in-place notice that says nothing moved, and can be dismissed", async () => {
    const onDismiss = vi.fn();
    render(<BlockNotice onDismiss={onDismiss} />);
    expect(screen.getByText(BLOCK_NOTICE_TITLE)).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("No funds moved");
    expect(BLOCK_NOTICE_BODY).toContain("Nothing was signed. No funds moved.");
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(onDismiss).toHaveBeenCalled();
  });
  it("skips the notice when that blocked row is already selected", () => {
    expect(shouldToastBlock("block:7", 7)).toBe(false);
    expect(shouldToastBlock("task_x", 7)).toBe(true);
  });
  it("ignores replayed history older than two minutes, except in mock mode", () => {
    const now = Date.parse("2026-10-18T16:00:00Z");
    expect(isFreshBlock("2026-10-18T15:59:00Z", now, false)).toBe(true);
    expect(isFreshBlock("2026-10-18T15:50:00Z", now, false)).toBe(false);
    expect(isFreshBlock("2026-10-18T15:50:00Z", now, true)).toBe(true);
  });
});
