// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MOCK_TASK_TYPES } from "../lib/taskTypes.js";
import { MOCK_EVENTS } from "../mock/events.js";
import { initialState, reduce, useStore } from "../store.js";
import { renderWithProviders } from "../test-utils.js";
import { NewTaskButton } from "./NewTaskButton.js";

afterEach(() => {
  cleanup();
  useStore.setState({ ...initialState });
});

const withMandate = () => {
  const s = MOCK_EVENTS.slice(0, 3).reduce(reduce, initialState);
  useStore.setState({ ...s });
};

describe("NewTaskButton shortcut signal", () => {
  it("ignores a signal that was raised before it mounted", () => {
    withMandate();
    renderWithProviders(<NewTaskButton openSignal={3} />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("opens when the signal changes while mounted", async () => {
    withMandate();
    const client = new QueryClient();
    const ui = (n: number) => (
      <QueryClientProvider client={client}>
        <NewTaskButton openSignal={n} />
      </QueryClientProvider>
    );
    const r = render(ui(3));
    r.rerender(ui(4));
    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect((screen.getByLabelText(/what should the worker do/i) as HTMLInputElement).value).toBe(
      "convert a CSV file into JSON",
    );
  });
});

const json = (status: number, body: unknown) =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));
const stubFetch = (types: () => Promise<Response>, post: (url: string) => Promise<Response>) => {
  const calls: { url: string; body: string }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      if (url.endsWith("/api/task-types")) return types();
      calls.push({ url, body: String(init?.body ?? "") });
      return post(url);
    }),
  );
  return calls;
};
const open = async () => {
  withMandate();
  renderWithProviders(<NewTaskButton />);
  fireEvent.click(screen.getByRole("button", { name: /new task/i }));
  return screen.findByRole("dialog");
};
afterEach(() => vi.unstubAllGlobals());

describe("NewTaskButton task types", () => {
  it("lists task types and selects the first by default", async () => {
    stubFetch(
      () => json(200, { task_types: MOCK_TASK_TYPES }),
      () => json(200, { ok: true }),
    );
    const d = await open();
    const radios = await within(d).findAllByRole("radio");
    expect(radios).toHaveLength(2);
    expect((radios[0] as HTMLInputElement).checked).toBe(true);
    expect(within(d).getByText("json-normalise-v1")).toBeTruthy();
    expect(
      within(d).getByText(/The buyer agent confirms the match before any payment/),
    ).toBeTruthy();
    expect(within(d).getByText(/The agent will be told: "Pay /)).toBeTruthy();
  });
  it("falls back to the csv2json type when the engine has no endpoint", async () => {
    stubFetch(
      () => json(404, {}),
      () => json(200, { ok: true }),
    );
    const d = await open();
    expect(await within(d).findAllByRole("radio")).toHaveLength(1);
    expect(within(d).getByText("csv2json-v1")).toBeTruthy();
  });
  it("disables SEND when no type is available", async () => {
    stubFetch(
      () => json(200, { task_types: [] }),
      () => json(200, { ok: true }),
    );
    const d = await open();
    await within(d).findByText(/no task type can be offered/);
    expect(
      (within(d).getByRole("button", { name: /start task/i }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
  it("renders a TASK_NOT_VERIFIABLE refusal in place and sends nothing else", async () => {
    const calls = stubFetch(
      () => json(200, { task_types: MOCK_TASK_TYPES }),
      () =>
        json(422, {
          ok: false,
          code: "TASK_NOT_VERIFIABLE",
          message: "Verdict only buys work it can verify.",
        }),
    );
    const d = await open();
    await within(d).findAllByRole("radio");
    fireEvent.click(within(d).getByRole("button", { name: /start task/i }));
    const alert = await waitFor(() => {
      const a = within(d)
        .getAllByRole("alert")
        .find((x) => /only buys work it can verify/.test(x.textContent ?? ""));
      if (!a) throw new Error("no refusal yet");
      return a;
    });
    expect(within(alert).getByText("csv2json-v1")).toBeTruthy();
    expect(within(alert).getByText("json-normalise-v1")).toBeTruthy();
    // Refused at the routing step: nothing reached the engine.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toMatch(/\/api\/route$/);
  });
  it("CHECK shows the buyer's mapping and SEND carries package_id and request", async () => {
    const calls = stubFetch(
      () => json(200, { ok: true, types: MOCK_TASK_TYPES }),
      (url) =>
        url.endsWith("/api/route")
          ? json(200, { ok: true, package_id: "json-normalise-v1", reason: "It names JSON." })
          : json(200, { ok: true, cap_hash: "a".repeat(64) }),
    );
    const d = await open();
    await within(d).findAllByRole("radio");
    fireEvent.click(within(d).getByRole("button", { name: /^check$/i }));
    await within(d).findByText(/mapped this to JSON-NORMALISE-V1: It names JSON/);
    expect((within(d).getAllByRole("radio")[1] as HTMLInputElement).checked).toBe(true);
    fireEvent.click(within(d).getByRole("button", { name: /start task/i }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/api/mandate/task"))).toBe(true));
    const body = calls.find((c) => c.url.endsWith("/api/mandate/task"))?.body ?? "";
    expect(body).toContain('"package_id":"json-normalise-v1"');
    expect(body).toContain('"request":"convert a CSV file into JSON"');
  });
});
