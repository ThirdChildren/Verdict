// @vitest-environment jsdom

import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eventsFor } from "../lib/events.js";
import { SCENES } from "../mock/storyboard.js";
import { initialState, useStore } from "../store.js";
import { renderWithProviders } from "../test-utils.js";
import { Inspector } from "./Inspector.js";

const settled = SCENES.find((s) => s.id === "settled")?.events ?? [];

beforeEach(() => {
  history.pushState({}, "", "/?mock=1");
  useStore.setState({ ...initialState });
  for (const e of settled) useStore.getState().apply(e);
});
afterEach(cleanup);

describe("Inspector", () => {
  it("has a Proof tab with the signers and an Events tab with raw messages", async () => {
    renderWithProviders(<Inspector mock />);
    expect(screen.getByRole("tab", { name: /proof/i }).getAttribute("aria-selected")).toBe("true");
    const signers = screen.getByRole("list", { name: "Who signed what" });
    for (const role of ["Principal", "Engine", "Buyer", "Worker", "Verifier"])
      expect(within(signers).getByText(role)).toBeTruthy();
    await userEvent.click(screen.getByRole("tab", { name: /events/i }));
    expect((await screen.findAllByText("TASK_STATE", { selector: "code" })).length).toBeGreaterThan(
      0,
    );
  });

  it("filters events by role and shows the JSON on demand", async () => {
    renderWithProviders(<Inspector mock />);
    await userEvent.click(screen.getByRole("tab", { name: /events/i }));
    const all = screen.getAllByRole("listitem").length;
    await userEvent.click(screen.getByRole("button", { name: /^verifier \d+/i }));
    const verifier = screen.getAllByRole("listitem").length;
    expect(verifier).toBeGreaterThan(0);
    expect(verifier).toBeLessThan(all);
    expect(screen.getAllByText("VERDICT", { selector: "code" }).length).toBe(verifier);
  });

  it("lists newest first and keeps only the selected task's messages", () => {
    const s = useStore.getState();
    const list = eventsFor(s);
    expect(list.length).toBeGreaterThan(3);
    for (let i = 1; i < list.length; i++)
      expect((list[i - 1]?.seq ?? 0) > (list[i]?.seq ?? 0)).toBe(true);
    expect(
      eventsFor({ ...s, selected: "task_ffffffffffffffff" }).every((e) => e.type === "CAP_ROOT"),
    ).toBe(true);
  });
});
