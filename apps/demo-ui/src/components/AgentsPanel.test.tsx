// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { uiEventSchema } from "@verdict/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentsData } from "../lib/agentsData.js";
import { mockVerifierTask, mockWorkerTask } from "../mock/agents.js";
import { SCENES } from "../mock/storyboard.js";
import { type AppState, blockKey, initialState, useStore } from "../store.js";
import { renderWithProviders } from "../test-utils.js";
import { AgentsBody, AgentsPanel } from "./AgentsPanel.js";

const TASK = "task_0123456789abcdef";
const FILE = { path: "result/out.json", content: '[\n  {"name": "Ada"}\n]' };
const scene = (id: string) => SCENES.find((s) => s.id === id)?.events ?? [];

const data = (over: Partial<AgentsData> = {}): AgentsData => ({
  worker: { status: "ready", data: mockWorkerTask(TASK) },
  verifier: { status: "ready", data: mockVerifierTask(TASK) },
  evidence: { status: "ready", data: null },
  delivery: { status: "ready", data: [FILE] },
  buyer: { status: "ready", data: [] },
  ...over,
});

function load(id: string): AppState {
  useStore.setState({ ...initialState });
  for (const e of scene(id)) useStore.getState().apply(e);
  return useStore.getState();
}

beforeEach(() => history.pushState({}, "", "/"));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("AgentsBody", () => {
  it("shows three agents and the work log for a paid task", () => {
    const s = load("settled");
    const { container } = render(<AgentsBody state={s} data={data()} />);
    for (const name of ["Buyer", "Worker", "Verifier", "Work log"])
      expect(screen.getByRole("heading", { name })).toBeTruthy();
    expect(container.textContent).toContain(`Accepted · task ${TASK}`);
    expect(container.querySelector('ol[aria-live="polite"]')).not.toBeNull();
    expect(container.textContent).toContain("not reported yet");
  });

  it("copies and downloads the full delivery", async () => {
    const user = userEvent.setup();
    const s = load("settled");
    render(<AgentsBody state={s} data={data()} />);
    const write = vi.spyOn(navigator.clipboard, "writeText");
    await user.click(screen.getByRole("button", { name: /copy result\/out.json/i }));
    expect(write).toHaveBeenCalledWith(FILE.content);
    URL.createObjectURL = vi.fn(() => "blob:test");
    URL.revokeObjectURL = vi.fn();
    const clicked: HTMLAnchorElement[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push(this);
    });
    await user.click(screen.getByRole("button", { name: /download out.json/i }));
    expect(clicked[0]?.download).toBe("out.json");
    expect(clicked[0]?.href).toBe("blob:test");
  });

  it("blocked attempt shows intent and code verbatim, worker and verifier not started", () => {
    load("settled");
    const ev = uiEventSchema.parse({
      seq: 900,
      at: "2026-10-18T16:00:00Z",
      type: "BLOCKED",
      data: {
        code: "AMOUNT_EXCEEDS_PER_TASK",
        message:
          "The agent asked to pay 50.00 tUSD, but your mandate allows at most 2.00 tUSD per task.",
        intent: {
          amount: "50.00",
          counterparty: `eip191:0x${"c".repeat(40)}`,
          rationale: "Pay everything now.",
        },
        cap_id: "cap_0123456789abcdef",
      },
    });
    useStore.getState().apply(ev);
    const s = useStore.getState();
    expect(s.selected).toBe(blockKey(900));
    const { container } = render(<AgentsBody state={s} data={data()} />);
    const text = container.textContent ?? "";
    expect(text).toContain("50.00 tUSD");
    expect(text).toContain("Pay everything now.");
    expect(text).toContain("AMOUNT_EXCEEDS_PER_TASK");
    expect(text).toContain("but your mandate allows at most 2.00 tUSD per task.");
    expect(screen.getAllByText(/^Not started/)).toHaveLength(2);
  });

  it("never renders a secret", () => {
    const s = load("settled");
    const { container } = render(<AgentsBody state={s} data={data()} />);
    expect(container.innerHTML.toLowerCase()).not.toContain("preimage");
  });

  it("asks to select a task when nothing is selected", () => {
    render(<AgentsBody state={{ ...initialState }} data={data()} />);
    expect(screen.getByText(/Select a task/)).toBeTruthy();
  });
});

describe("AgentsPanel", () => {
  it("lists the attempts of the selected task, not the newest", async () => {
    load("settled");
    const att = (n: number, self_check: string) => ({
      n,
      seconds: 1,
      tokens_per_sec: 10,
      self_check,
    });
    const json = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body)));
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url.endsWith("/v0/tasks"))
          return json({
            tasks: [
              { taskId: TASK, state: "DELIVERED", attempts: [att(1, "FAIL"), att(2, "PASS")] },
              { taskId: "task_ffffffffffffffff", state: "ACCEPTED", attempts: [att(3, "PASS")] },
            ],
          });
        if (url.includes("/delivery")) return json({ files: [FILE] });
        return Promise.resolve(new Response("{}", { status: 503 }));
      }),
    );
    renderWithProviders(
      <AgentsPanel open onOpenChange={() => {}} mock={false} descriptions={{}} />,
    );
    await waitFor(() => expect(screen.getByText("Attempt 2/3")).toBeTruthy());
    expect(screen.queryByText("Attempt 3/3")).toBeNull();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("mock scene renders canned data and fetches nothing", async () => {
    history.pushState({}, "", "/?mock=1");
    load("settled");
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    renderWithProviders(<AgentsPanel open onOpenChange={() => {}} mock descriptions={{}} />);
    await waitFor(() => expect(screen.getByText("Attempt 3/3")).toBeTruthy());
    expect(f).not.toHaveBeenCalled();
    expect(document.body.innerHTML.toLowerCase()).not.toContain("preimage");
  });

  it("closes on the key a", async () => {
    load("settled");
    const close = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("down"))),
    );
    renderWithProviders(<AgentsPanel open onOpenChange={close} mock={false} descriptions={{}} />);
    await userEvent.keyboard("a");
    expect(close).toHaveBeenCalledWith(false);
  });
});
