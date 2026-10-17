// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stalledReason, WorkerLane } from "./WorkerLane.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** A fake worker: holds the switches, and "runs a task" by reading them, the way the real worker does at task start. */
function fakeWorker(opts: { failPost?: boolean } = {}) {
  const state = { sabotaged: false, disappears: false };
  const tasks: { taskId: string; state: string; toggles: typeof state }[] = [];
  const posts: unknown[] = [];
  const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url, "http://x").pathname;
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
    if (path === "/v0/config" && init?.method === "POST") {
      posts.push(JSON.parse(String(init.body)));
      if (opts.failPost) return json({ ok: false }, 500);
      Object.assign(state, JSON.parse(String(init.body)));
      return json({ ...state });
    }
    if (path === "/v0/config") return json({ ...state });
    if (path === "/v0/tasks") return json({ tasks });
    return json({}, 404);
  });
  const startTask = () => {
    const toggles = { ...state };
    tasks.push({
      taskId: `t${tasks.length}`,
      state: toggles.sabotaged ? "CANCELLED" : "CLAIMED",
      toggles,
    });
    return toggles.sabotaged ? "FAIL" : "PASS";
  };
  return { fetchFn, state, posts, startTask };
}

beforeEach(() => {
  vi.stubGlobal(
    "WebSocket",
    class {
      close() {}
      addEventListener() {}
      onmessage = null;
    },
  );
});

describe("demo switches apply live, in one page session", () => {
  it("on -> the next task fails, off -> the next task passes, with no reload", async () => {
    const w = fakeWorker();
    vi.stubGlobal("fetch", w.fetchFn);
    render(<WorkerLane />);
    const box = (await screen.findByLabelText(/Sabotaged worker/)) as HTMLInputElement;
    await waitFor(() => expect(box.disabled).toBe(false));

    fireEvent.click(box);
    await waitFor(() =>
      expect(screen.getByTestId("toggle-badge").textContent).toContain("SABOTAGED"),
    );
    expect(w.posts).toEqual([{ sabotaged: true }]);
    expect(w.startTask()).toBe("FAIL");

    fireEvent.click(box);
    await waitFor(() => expect(screen.queryByTestId("toggle-badge")).toBeNull());
    expect(w.posts).toEqual([{ sabotaged: true }, { sabotaged: false }]);
    expect(w.startTask()).toBe("PASS");
  });

  it("a failed call shows an error and leaves the checkbox as the worker reports it", async () => {
    const w = fakeWorker({ failPost: true });
    vi.stubGlobal("fetch", w.fetchFn);
    render(<WorkerLane />);
    const box = (await screen.findByLabelText(/Sabotaged worker/)) as HTMLInputElement;
    await waitFor(() => expect(box.disabled).toBe(false));
    fireEvent.click(box);
    await screen.findByRole("alert");
    expect(screen.getByRole("alert").textContent).toContain("was not changed");
    expect(box.checked).toBe(false);
    expect(screen.queryByTestId("toggle-badge")).toBeNull();
  });

  it("the task row shows the switches the worker recorded when the task started", async () => {
    const w = fakeWorker();
    w.state.sabotaged = true;
    w.startTask();
    w.state.sabotaged = false;
    vi.stubGlobal("fetch", w.fetchFn);
    render(<WorkerLane />);
    const row = await screen.findByTestId("task-toggles");
    expect(row.textContent).toContain("SABOTAGED");
  });
});

describe("stalledReason", () => {
  it("is silent until a task has waited for its payment for 45 s, then explains", () => {
    expect(stalledReason("INVOICE_SENT", 0, 44_000)).toBeNull();
    expect(stalledReason("GENERATING", 0, 90_000)).toBeNull();
    expect(stalledReason("INVOICE_SENT", null, 90_000)).toBeNull();
    expect(stalledReason("INVOICE_SENT", 0, 45_000)).toMatch(/demo:reset/);
  });
});
