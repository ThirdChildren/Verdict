// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
  it("lists task types with no default selection and START disabled", async () => {
    stubFetch(
      () => json(200, { task_types: MOCK_TASK_TYPES }),
      () => json(200, { ok: true }),
    );
    const d = await open();
    const radios = await within(d).findAllByRole("radio");
    expect(radios).toHaveLength(2);
    expect(radios.every((x) => !(x as HTMLInputElement).checked)).toBe(true);
    expect(
      (within(d).getByRole("button", { name: /start task/i }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      within(d).getByText(
        "Pick a test type, press CHECK to let the buyer agent map your text, or WRITE A TEST.",
      ),
    ).toBeTruthy();
    expect(within(d).getByText("json-normalise-v1")).toBeTruthy();
    fireEvent.click(radios[0] as HTMLElement);
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
  it("says the engine cannot be reached when the fetch fails", async () => {
    stubFetch(
      () => Promise.reject(new TypeError("down")),
      () => json(200, { ok: true }),
    );
    const d = await open();
    expect(
      await within(d).findByText(/^Cannot reach the engine at https?:\/\/.+\. Is it running\?$/),
    ).toBeTruthy();
  });
  it("shows the verifier line when reachable, not reachable, and omits it when absent", async () => {
    stubFetch(
      () =>
        json(200, {
          ok: true,
          types: MOCK_TASK_TYPES,
          verifier_reachable: true,
          verifier_url: "http://192.168.1.5:7410",
        }),
      () => json(200, { ok: true }),
    );
    const d = await open();
    expect(await within(d).findByText("Verifier: reachable at 192.168.1.5:7410")).toBeTruthy();
    cleanup();
    stubFetch(
      () =>
        json(200, {
          ok: true,
          types: MOCK_TASK_TYPES,
          verifier_reachable: false,
          verifier_url: "x",
        }),
      () => json(200, { ok: true }),
    );
    const d2 = await open();
    expect(
      await within(d2).findByText(
        "Verifier: not reachable from the engine; tasks will be refused at deposit",
      ),
    ).toBeTruthy();
    cleanup();
    stubFetch(
      () => json(200, { ok: true, types: MOCK_TASK_TYPES }),
      () => json(200, { ok: true }),
    );
    const d3 = await open();
    await within(d3).findAllByRole("radio");
    expect(within(d3).queryByText(/^Verifier:/)).toBeNull();
  });
  it("disables SEND when no type is available", async () => {
    stubFetch(
      () => json(200, { task_types: [] }),
      () => json(200, { ok: true }),
    );
    const d = await open();
    await within(d).findByText(
      "The engine offers no task type. Its package catalogue is empty: check VERIFIER_PACKAGES_ROOT on the engine.",
    );
    expect(
      (within(d).getByRole("button", { name: /start task/i }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
  it("renders a routing refusal from Check in place, with the reason and the raw last answer", async () => {
    const calls = stubFetch(
      () => json(200, { task_types: [] }),
      () =>
        json(422, {
          ok: false,
          code: "TASK_NOT_VERIFIABLE",
          message: "Verdict only buys work it can verify.",
          reason: "No type reads a poem.",
          task_types: [{ id: "csv2json-v1", title: "CSV to JSON" }],
        }),
    );
    const d = await open();
    await within(d).findByText(/offers no task type/i);
    fireEvent.click(within(d).getByRole("button", { name: /^check$/i }));
    const alert = await waitFor(() => {
      const a = within(d)
        .getAllByRole("alert")
        .find((x) => /only buys work it can verify/.test(x.textContent ?? ""));
      if (!a) throw new Error("no refusal yet");
      return a;
    });
    expect(within(alert).getByText("csv2json-v1")).toBeTruthy();
    expect(
      within(alert).getByText("Routing: the buyer agent answered none: No type reads a poem."),
    ).toBeTruthy();
    expect(calls[0]?.url).toMatch(/\/api\/route$/);
    expect(calls.some((c) => c.url.endsWith("/api/mandate/task"))).toBe(false);
    const raw = within(d).getByText("Last answer").closest("details");
    expect(raw?.textContent).toContain('"reason": "No type reads a poem."');
  });
  it("uses the selected type without calling /api/route, and tells the buyer the package", async () => {
    const calls = stubFetch(
      () => json(200, { ok: true, types: MOCK_TASK_TYPES }),
      (url) =>
        url.endsWith("/api/plan")
          ? json(200, { ok: true, decision: { status: "FORWARDED" } })
          : json(200, { ok: true, cap_hash: "a".repeat(64) }),
    );
    const d = await open();
    await within(d).findAllByRole("radio");
    fireEvent.click(within(d).getAllByRole("radio")[1] as HTMLElement);
    expect(within(d).getByText(/Using the type you selected: .*; no check needed\./)).toBeTruthy();
    fireEvent.click(within(d).getByRole("button", { name: /start task/i }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/api/plan"))).toBe(true));
    expect(calls.some((c) => c.url.endsWith("/api/route"))).toBe(false);
    expect(calls.find((c) => c.url.endsWith("/api/mandate/task"))?.body).toContain(
      '"package_id":"json-normalise-v1"',
    );
    expect(calls.find((c) => c.url.endsWith("/api/plan"))?.body).toContain(
      '"package_id":"json-normalise-v1"',
    );
  });
  it("shows the engine's BLOCKED decision from /api/plan instead of 'Task sent'", async () => {
    stubFetch(
      () => json(200, { ok: true, types: MOCK_TASK_TYPES }),
      (url) =>
        url.endsWith("/api/plan")
          ? json(200, {
              ok: true,
              decision: { status: "BLOCKED", code: "OVER_BUDGET", message: "Too much." },
            })
          : json(200, { ok: true, cap_hash: "a".repeat(64) }),
    );
    const d = await open();
    fireEvent.click((await within(d).findAllByRole("radio"))[0] as HTMLElement);
    fireEvent.click(within(d).getByRole("button", { name: /start task/i }));
    expect(
      await within(d).findByText("The engine blocked the task: OVER_BUDGET Too much."),
    ).toBeTruthy();
    expect(screen.queryByText(/Task sent/)).toBeNull();
  });
  it("shows an ERROR decision as the buyer failing to reach the engine", async () => {
    stubFetch(
      () => json(200, { ok: true, types: MOCK_TASK_TYPES }),
      (url) =>
        url.endsWith("/api/plan")
          ? json(200, { ok: true, decision: { status: "ERROR", message: "ECONNREFUSED" } })
          : json(200, { ok: true, cap_hash: "a".repeat(64) }),
    );
    const d = await open();
    fireEvent.click((await within(d).findAllByRole("radio"))[0] as HTMLElement);
    fireEvent.click(within(d).getByRole("button", { name: /start task/i }));
    expect(
      await within(d).findByText("The buyer could not reach the engine: ECONNREFUSED"),
    ).toBeTruthy();
  });
  it("names the origin to allow on a 403", async () => {
    stubFetch(
      () => json(200, { ok: true, types: MOCK_TASK_TYPES }),
      () => json(403, { ok: false, code: "FORBIDDEN_ORIGIN", message: "Origin refused." }),
    );
    const d = await open();
    fireEvent.click((await within(d).findAllByRole("radio"))[0] as HTMLElement);
    fireEvent.click(within(d).getByRole("button", { name: /start task/i }));
    expect(
      await within(d).findByText(
        new RegExp(
          `set VERDICT_UI_ORIGIN=${window.location.origin} on the engine, signer and buyer`,
        ),
      ),
    ).toBeTruthy();
  });
  it("explains CATALOGUE_UNAVAILABLE from /api/route", async () => {
    stubFetch(
      () => json(200, { ok: true, types: MOCK_TASK_TYPES }),
      () => json(503, { ok: false, code: "CATALOGUE_UNAVAILABLE", message: "engine down" }),
    );
    const d = await open();
    await within(d).findAllByRole("radio");
    fireEvent.click(within(d).getByRole("button", { name: /^check$/i }));
    expect(
      await within(d).findByText(
        "The buyer agent cannot read the engine's task-type list (engine down)",
      ),
    ).toBeTruthy();
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
  it("renders a refusal from the engine's 422 in place, with the list and no buyer goal call", async () => {
    const calls = stubFetch(
      () => json(200, { task_types: MOCK_TASK_TYPES }),
      (url) =>
        url.endsWith("/api/route")
          ? json(200, { ok: true, package_id: "csv2json-v1", reason: "CSV in, JSON out." })
          : json(422, {
              ok: false,
              code: "TASK_NOT_VERIFIABLE",
              message: "Engine says: Verdict only buys work it can verify.",
            }),
    );
    const d = await open();
    fireEvent.click((await within(d).findAllByRole("radio"))[0] as HTMLElement);
    fireEvent.click(within(d).getByRole("button", { name: /start task/i }));
    const alert = await waitFor(() => {
      const a = within(d)
        .getAllByRole("alert")
        .find((x) => /Engine says: Verdict only buys work/.test(x.textContent ?? ""));
      if (!a) throw new Error("no refusal yet");
      return a;
    });
    expect(within(alert).getByText("json-normalise-v1")).toBeTruthy();
    expect(calls.some((c) => c.url.endsWith("/api/mandate/task"))).toBe(true);
    expect(calls.some((c) => c.url.endsWith("/api/plan"))).toBe(false);
    expect(within(d).queryByRole("dialog")).toBeNull();
  });
});

describe("task type list and refusal", () => {
  it("shows the title as the label, the id muted, and the description only under Details", async () => {
    stubFetch(
      () => json(200, { task_types: MOCK_TASK_TYPES }),
      () => json(200, { ok: true }),
    );
    const d = await open();
    await within(d).findAllByRole("radio");
    expect(within(d).getByText("Normalise a JSON document")).toBeTruthy();
    const summaries = within(d).getAllByText(/Details/);
    expect(summaries).toHaveLength(2);
    const det = summaries[1]?.closest("details");
    expect(det?.open).toBe(false);
    fireEvent.click(summaries[1] as HTMLElement);
    expect(det?.open).toBe(true);
    expect(within(det as HTMLElement).getByText(/sorted keys/)).toBeTruthy();
  });
  it("falls back to the id when the engine sends no title", async () => {
    stubFetch(
      () => json(200, { task_types: [{ id: "old-v1", description: "" }] }),
      () => json(200, { ok: true }),
    );
    const d = await open();
    await within(d).findAllByRole("radio");
    expect(within(d).getByText("old-v1", { selector: ".font-semibold" })).toBeTruthy();
    expect(within(d).queryByText(/Details/)).toBeNull();
  });
  it("lists the types once in a refusal, from the body titles, without the long description", async () => {
    stubFetch(
      () => json(200, { task_types: MOCK_TASK_TYPES }),
      () =>
        json(422, {
          ok: false,
          code: "TASK_NOT_VERIFIABLE",
          message: "Only these kinds of work can be verified.",
          task_types: [{ id: "csv2json-v1", title: "Refusal title one" }],
        }),
    );
    const d = await open();
    fireEvent.click((await within(d).findAllByRole("radio"))[0] as HTMLElement);
    fireEvent.click(within(d).getByRole("button", { name: /start task/i }));
    const alert = await waitFor(() => {
      const a = within(d)
        .getAllByRole("alert")
        .find((x) => /Only these kinds/.test(x.textContent ?? ""));
      if (!a) throw new Error("no refusal yet");
      return a;
    });
    expect(within(alert).getAllByText(/Refusal title one/)).toHaveLength(1);
    expect(within(alert).queryByText(/sorted keys/)).toBeNull();
    expect(within(alert).getAllByText("Nothing was sent.")).toHaveLength(1);
    expect(within(alert).getByText(/docs\/FAQ\.md/)).toBeTruthy();
  });
});

describe("NewTaskButton acceptance test", () => {
  const draft = (over: Record<string, unknown> = {}) => ({
    feasibility: "cli",
    reason: "checkable",
    title: "Sum two numbers",
    description: "Print the sum.",
    entry: "main.py",
    input_ext: "txt",
    visible: [
      { input: "1 2", expected: "3" },
      { input: "2 2", expected: "4" },
      { input: "0 0", expected: "0" },
    ],
    hidden: [1, 2, 3, 4, 5].map((n) => ({ input: `${n} 0`, expected: `${n}` })),
    assertions: { max_output_bytes: 4096, forbidden_tokens: ["error"] } as unknown,
    ...over,
  });
  const authorBody = (top: Record<string, unknown> = {}) => {
    const { feasibility, reason, ...rest } = draft();
    return json(200, { ok: true, feasibility, reason, ...top, draft: rest });
  };
  const stub = (
    author: () => Promise<Response>,
    install: () => Promise<Response>,
    types: unknown[] = MOCK_TASK_TYPES,
    routeReason?: string,
  ) => {
    const posted: { url: string; body: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init?: RequestInit) => {
        if (init?.method !== "POST") return json(200, { task_types: types });
        posted.push({ url, body: String(init.body) });
        if (url.endsWith("/api/route"))
          return json(422, {
            ok: false,
            code: "TASK_NOT_VERIFIABLE",
            message: "No type matches.",
            ...(routeReason ? { reason: routeReason } : {}),
          });
        return url.endsWith("/api/author") ? author() : install();
      }),
    );
    return posted;
  };
  const fill = async (d: HTMLElement, text: string) => {
    fireEvent.change(within(d).getByLabelText(/what should the worker do/i), {
      target: { value: text },
    });
  };

  it("shows the panel after a Check that answers none, hidden cases stay out of sight", async () => {
    stub(
      () => authorBody(),
      () => json(200, { ok: true }),
      [],
    );
    const d = await open();
    await fill(d, "sum two numbers");
    fireEvent.click(within(d).getByRole("button", { name: /^check$/i }));
    fireEvent.click(await within(d).findByRole("button", { name: /^write a test$/i }));
    const panel = await within(d).findByRole("region", { name: /acceptance test/i });
    expect(within(panel).getByText(/reads a file and prints a result/)).toBeTruthy();
    expect(within(panel).getByText(/5 more cases stay hidden from the worker/)).toBeTruthy();
    expect(within(panel).getByText("Output at most 4096 bytes")).toBeTruthy();
    expect(within(panel).getByText("Must not contain: error")).toBeTruthy();
    expect(within(panel).getAllByRole("textbox")).toHaveLength(2 + 6);
  });
  it("with a type selected, a none answer is information: no author call, no refusal block", async () => {
    const posted = stub(
      () => authorBody(),
      () => json(200, { ok: true }),
      MOCK_TASK_TYPES,
      "No type reads a poem.",
    );
    const d = await open();
    fireEvent.click((await within(d).findAllByRole("radio"))[0] as HTMLElement);
    await fill(d, "write a poem");
    fireEvent.click(within(d).getByRole("button", { name: /^check$/i }));
    await within(d).findByText(/would map this text to none: No type reads a poem\./);
    expect(within(d).getByText(/stands only if you confirm/)).toBeTruthy();
    expect(within(d).queryByText("Nothing was sent.")).toBeNull();
    expect(posted.some((c) => c.url.endsWith("/api/author"))).toBe(false);
  });

  it("with no type selected, a none answer offers WRITE A TEST without launching it", async () => {
    const posted = stub(
      () => authorBody(),
      () => json(200, { ok: true }),
      [],
    );
    const d = await open();
    await fill(d, "sum two numbers");
    fireEvent.click(within(d).getByRole("button", { name: /^check$/i }));
    await within(d).findByText(/Nothing was sent\./);
    expect(posted.some((c) => c.url.endsWith("/api/author"))).toBe(false);
    fireEvent.click(within(d).getByRole("button", { name: /^write a test$/i }));
    await within(d).findByRole("region", { name: /acceptance test/i });
    expect(posted.some((c) => c.url.endsWith("/api/author"))).toBe(true);
  });

  it("offers 'Use <title> instead' when the reason names another type, and switches", async () => {
    stub(
      () => authorBody(),
      () => json(200, { ok: true }),
      MOCK_TASK_TYPES,
      `This is about ${MOCK_TASK_TYPES[1]?.title ?? ""}.`,
    );
    const d = await open();
    fireEvent.click((await within(d).findAllByRole("radio"))[0] as HTMLElement);
    await fill(d, "something");
    fireEvent.click(within(d).getByRole("button", { name: /^check$/i }));
    const sw = await within(d).findByRole("button", { name: /^use .* instead$/i });
    fireEvent.click(sw);
    const radios = within(d).getAllByRole("radio") as HTMLInputElement[];
    expect(radios[1]?.checked).toBe(true);
  });

  it("does not double 'Nothing was installed.'", async () => {
    stub(
      () =>
        json(422, { ok: false, code: "DRAFT_REJECTED", message: "Bad. Nothing was installed." }),
      () => json(200, { ok: true }),
      [],
    );
    const d = await open();
    await fill(d, "sum two numbers");
    fireEvent.click(within(d).getByRole("button", { name: /^check$/i }));
    fireEvent.click(await within(d).findByRole("button", { name: /^write a test$/i }));
    await within(d).findAllByText(/Nothing was installed\./);
    expect(d.textContent).not.toMatch(/Nothing was installed\. Nothing was installed\./);
  });

  it("reads an empty assertions object and counts the rules after install", async () => {
    stub(
      () => {
        const { feasibility, reason, ...rest } = draft({ assertions: {} });
        return json(200, { ok: true, feasibility, reason, draft: rest });
      },
      () => json(200, { ok: true, id: "custom-ab12cd34-v1", package_sha256: "ab12cd34".repeat(8) }),
    );
    const d = await open();
    fireEvent.click(within(d).getByRole("button", { name: /write a test/i }));
    await within(d).findByRole("region", { name: /acceptance test/i });
    expect(within(d).queryByText("The rules, in words")).toBeNull();
    fireEvent.click(within(d).getByRole("button", { name: /install test and use it/i }));
    expect(await within(d).findByText("Installed: 5 hidden cases, 3 shown, 0 rules")).toBeTruthy();
  });
  it("sends the assertions object through unchanged", async () => {
    const posted = stub(
      () => authorBody(),
      () => json(200, { ok: true, id: "custom-ab12cd34-v1", package_sha256: "ab12cd34".repeat(8) }),
    );
    const d = await open();
    fireEvent.click(within(d).getByRole("button", { name: /write a test/i }));
    await within(d).findByRole("region", { name: /acceptance test/i });
    fireEvent.click(within(d).getByRole("button", { name: /install test and use it/i }));
    await within(d).findByText(/Installed: 5 hidden cases, 3 shown, 2 rules/);
    const sent = JSON.parse(posted.find((p) => p.url.endsWith("/api/task-types"))?.body ?? "{}");
    expect(sent.draft.assertions).toEqual({ max_output_bytes: 4096, forbidden_tokens: ["error"] });
  });
  it("names the zod path when the buyer's test cannot be read", async () => {
    stub(
      () => json(200, { ok: true, draft: { title: "x" } }),
      () => json(200, { ok: true }),
    );
    const d = await open();
    fireEvent.click(within(d).getByRole("button", { name: /write a test/i }));
    expect(
      await within(d).findByText(/The buyer agent's test could not be read: feasibility: /),
    ).toBeTruthy();
  });
  it("uses an installed custom type on start without calling /api/route", async () => {
    const posted = stub(
      () => authorBody(),
      (() => {
        let n = 0;
        return () =>
          json(
            200,
            ++n === 1
              ? { ok: true, id: "custom-ab12cd34-v1", package_sha256: "ab12cd34".repeat(8) }
              : { ok: true, cap_hash: "a".repeat(64) },
          );
      })(),
    );
    const d = await open();
    fireEvent.click(within(d).getByRole("button", { name: /write a test/i }));
    await within(d).findByRole("region", { name: /acceptance test/i });
    fireEvent.click(within(d).getByRole("button", { name: /install test and use it/i }));
    await within(d).findAllByText(/Installed: /);
    expect(
      within(d).getByText(/Using the type you selected: .*\(custom · ab12cd34\); no check needed/),
    ).toBeTruthy();
    fireEvent.click(within(d).getByRole("button", { name: /start task/i }));
    await waitFor(() => expect(posted.some((p) => p.url.endsWith("/api/plan"))).toBe(true));
    expect(posted.some((p) => p.url.endsWith("/api/route"))).toBe(false);
    expect(posted.find((p) => p.url.endsWith("/api/mandate/task"))?.body).toContain(
      '"package_id":"custom-ab12cd34-v1"',
    );
  });
  it("shows the reframe sentence", async () => {
    stub(
      () =>
        authorBody({ feasibility: "reframe", reframe: "A game cannot be tested; its score can." }),
      () => json(200, { ok: true }),
    );
    const d = await open();
    await fill(d, "snake game");
    fireEvent.click(within(d).getByRole("button", { name: /write a test/i }));
    expect(await within(d).findByText("A game cannot be tested; its score can.")).toBeTruthy();
  });
  it("sends an edited visible case, installs and selects the new type", async () => {
    const posted = stub(
      () => authorBody(),
      () =>
        json(200, {
          ok: true,
          id: "custom-ab12cd34-v1",
          package_sha256: "ab12cd34".repeat(8),
          title: "Sum two numbers",
        }),
    );
    const d = await open();
    fireEvent.click(within(d).getByRole("button", { name: /write a test/i }));
    const cell = await within(d).findByLabelText("Case 1 expected output");
    fireEvent.change(cell, { target: { value: "99" } });
    fireEvent.click(within(d).getByRole("button", { name: /install test and use it/i }));
    expect(
      (await within(d).findAllByText(/custom · ab12cd34/, { selector: "span.font-mono" }))[0],
    ).toBeTruthy();
    const sent = JSON.parse(posted.find((p) => p.url.endsWith("/api/task-types"))?.body ?? "{}");
    expect(sent.draft.visible[0].expected).toBe("99");
    expect(sent.draft.hidden).toHaveLength(5);
    const radios = await within(d).findAllByRole("radio");
    const picked = radios.find((r) => (r as HTMLInputElement).checked);
    expect((picked as HTMLInputElement).value).toBe("custom-ab12cd34-v1");
    expect(within(d).queryByRole("region", { name: /acceptance test/i })).toBeNull();
  });
  it("renders DRAFT_REJECTED in place and keeps the panel", async () => {
    stub(
      () => authorBody(),
      () =>
        json(422, {
          ok: false,
          code: "DRAFT_REJECTED",
          message: "Every expected output is the same.",
        }),
    );
    const d = await open();
    fireEvent.click(within(d).getByRole("button", { name: /write a test/i }));
    await within(d).findByRole("region", { name: /acceptance test/i });
    fireEvent.click(within(d).getByRole("button", { name: /install test and use it/i }));
    expect(await within(d).findByText("Every expected output is the same.")).toBeTruthy();
    expect(within(d).getByRole("region", { name: /acceptance test/i })).toBeTruthy();
  });
  it("renders an authoring refusal in place", async () => {
    stub(
      () =>
        json(422, {
          ok: false,
          code: "TASK_NOT_VERIFIABLE",
          message: "A blog post cannot be tested.",
        }),
      () => json(200, { ok: true }),
    );
    const d = await open();
    fireEvent.click(within(d).getByRole("button", { name: /write a test/i }));
    expect(
      await within(d).findByText(/A blog post cannot be tested\. Nothing was installed/),
    ).toBeTruthy();
  });
});

describe("NewTaskButton explicit override", () => {
  const routeStub = (routeAnswer: () => Promise<Response>) =>
    stubFetch(
      () => json(200, { ok: true, types: MOCK_TASK_TYPES }),
      (url) =>
        url.endsWith("/api/route")
          ? routeAnswer()
          : url.endsWith("/api/plan")
            ? json(200, { ok: true, decision: { status: "FORWARDED" } })
            : json(200, { ok: true, cap_hash: "a".repeat(64) }),
    );
  const none = () =>
    json(422, { ok: false, code: "TASK_NOT_VERIFIABLE", message: "No type matches." });
  const text = (d: HTMLElement, v: string) =>
    fireEvent.change(within(d).getByLabelText(/what should the worker do/i), {
      target: { value: v },
    });

  it("CHECK with no selection selects the routed type", async () => {
    routeStub(() => json(200, { ok: true, package_id: "json-normalise-v1", reason: "JSON." }));
    const d = await open();
    await within(d).findAllByRole("radio");
    fireEvent.click(within(d).getByRole("button", { name: /^check$/i }));
    await within(d).findByText(/mapped this to JSON-NORMALISE-V1/);
    expect((within(d).getAllByRole("radio")[1] as HTMLInputElement).checked).toBe(true);
    expect(within(d).queryByRole("button", { name: /anyway/i })).toBeNull();
    expect(
      (within(d).getByRole("button", { name: /start task/i }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });
  it("shows USE <TITLE> ANYWAY on disagreement and proceeds only on confirm; editing the text clears it", async () => {
    const calls = routeStub(none);
    const d = await open();
    fireEvent.click((await within(d).findAllByRole("radio"))[0] as HTMLElement);
    text(d, "develop a snake game");
    fireEvent.click(within(d).getByRole("button", { name: /^check$/i }));
    const title = MOCK_TASK_TYPES[0]?.title ?? "";
    const word = await within(d).findByRole("button", { name: `Use ${title} anyway` });
    expect(within(d).queryByRole("button", { name: /start task/i })).toBeNull();
    expect(
      within(d).getByText(
        `The buyer agent would not map this text to ${title}; the worker will refuse the job if its test cannot verify it. Confirm to proceed.`,
      ),
    ).toBeTruthy();
    expect(calls.some((c) => c.url.endsWith("/api/mandate/task"))).toBe(false);
    text(d, "develop a snake game now");
    expect(within(d).queryByRole("button", { name: /anyway/i })).toBeNull();
    expect(within(d).getByRole("button", { name: /start task/i })).toBeTruthy();
    fireEvent.click(within(d).getByRole("button", { name: /^check$/i }));
    fireEvent.click(await within(d).findByRole("button", { name: `Use ${title} anyway` }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/api/mandate/task"))).toBe(true));
    expect(word).toBeTruthy();
  });
  it("a successful install selects the custom type and clears the override", async () => {
    const posted: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init?: RequestInit) => {
        if (init?.method !== "POST") return json(200, { task_types: MOCK_TASK_TYPES });
        posted.push(url);
        if (url.endsWith("/api/route")) return none();
        if (url.endsWith("/api/author"))
          return json(200, {
            ok: true,
            feasibility: "cli",
            reason: "ok",
            draft: {
              title: "Snake",
              description: "d",
              entry: "main.py",
              input_ext: "txt",
              visible: [{ input: "1", expected: "1" }],
              hidden: [{ input: "2", expected: "2" }],
              assertions: {},
            },
          });
        return json(200, {
          ok: true,
          id: "snake-v1",
          title: "Snake",
          package_sha256: "b".repeat(64),
        });
      }),
    );
    const d = await open();
    fireEvent.click((await within(d).findAllByRole("radio"))[0] as HTMLElement);
    text(d, "develop a snake game");
    fireEvent.click(within(d).getByRole("button", { name: /^check$/i }));
    await within(d).findByRole("button", { name: /anyway/i });
    fireEvent.click(within(d).getByRole("button", { name: /^write a test$/i }));
    await within(d).findByRole("region", { name: /acceptance test/i });
    fireEvent.click(within(d).getByRole("button", { name: /install/i }));
    await within(d).findByText(/Installed: .*Snake/);
    expect(within(d).queryByRole("button", { name: /anyway/i })).toBeNull();
    const start = within(d).getByRole("button", { name: /start task/i }) as HTMLButtonElement;
    expect(start.disabled).toBe(false);
    const radios = within(d).getAllByRole("radio") as HTMLInputElement[];
    expect(radios.find((x) => x.checked)?.value).toBe("snake-v1");
  });
});

describe("NewTaskButton announced task types (E33)", () => {
  it("lists a type announced by TASK_TYPE_ADDED that the engine list does not show yet", async () => {
    stubFetch(
      () => json(200, { task_types: MOCK_TASK_TYPES }),
      () => json(200, { ok: true }),
    );
    const d = await open();
    act(() =>
      useStore.getState().addTaskType({
        id: "custom-sum-12345678",
        title: "Sum two numbers",
        package_sha256: "a".repeat(64),
      }),
    );
    await waitFor(() => expect(within(d).getAllByRole("radio")).toHaveLength(3));
    expect(within(d).getByText("Sum two numbers")).toBeTruthy();
  });
});
