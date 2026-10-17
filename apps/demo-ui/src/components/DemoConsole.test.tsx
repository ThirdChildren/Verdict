// @vitest-environment jsdom

import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SCENES } from "../mock/storyboard.js";
import { initialState, useStore } from "../store.js";
import { renderWithProviders } from "../test-utils.js";
import { DemoConsole } from "./DemoConsole.js";

const locked = SCENES.find((s) => s.id === "ring")?.events ?? [];

beforeEach(() => {
  history.pushState({}, "", "/");
  useStore.setState({ ...initialState });
  for (const e of locked) useStore.getState().apply(e);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function stub(mine: unknown, worker = { sabotaged: false, disappears: true }) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("/v0/config"))
      return new Response(
        JSON.stringify(
          init?.method === "POST" ? { ...worker, ...JSON.parse(String(init.body)) } : worker,
        ),
      );
    if (u.includes("mine-until-refund")) return new Response(JSON.stringify(mine));
    return new Response("{}", { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("DemoConsole", () => {
  it("renders nothing while closed", () => {
    stub({ ok: true });
    renderWithProviders(<DemoConsole open={false} onClose={() => {}} />);
    expect(screen.queryByRole("complementary")).toBeNull();
  });
  it("shows the worker's real switches", async () => {
    stub({ ok: true });
    renderWithProviders(<DemoConsole open onClose={() => {}} />);
    expect(await screen.findByText("Disappears: on")).toBeTruthy();
    expect(screen.getByText("Sabotaged: off")).toBeTruthy();
    await userEvent.click(screen.getByRole("switch", { name: /sabotaged/i }));
    expect(await screen.findByText("Sabotaged: on")).toBeTruthy();
  });
  it.each([
    ["DEMO_LOCAL_ONLY", /only the machine that runs the engine/i],
    ["DEMO_BAD_REQUEST", /select a task/i],
    ["DEMO_TASK_UNKNOWN", /does not know this task/i],
    ["DEMO_ALREADY_MINING", /already being mined/i],
    ["DEMO_OTHER_PAYMENT_IN_FLIGHT", /another payment is still in progress/i],
  ])("explains %s in plain language", async (code, text) => {
    stub({ ok: false, code, message: "raw engine text" });
    renderWithProviders(<DemoConsole open onClose={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: /^mine until refund$/i }));
    expect((await screen.findByRole("alert")).textContent).toMatch(text);
  });
  it("shows mining progress from the event stream", async () => {
    stub({ ok: true });
    const id = useStore.getState().selected as string;
    renderWithProviders(<DemoConsole open onClose={() => {}} />);
    useStore
      .getState()
      .setMine({ task_id: id, height: 120, target_height: 200, percent: 40, state: "mining" });
    expect(await screen.findByText(/block 120 of 200 \(40%\)/)).toBeTruthy();
  });
});
