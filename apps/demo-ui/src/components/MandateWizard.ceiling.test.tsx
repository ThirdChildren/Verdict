// @vitest-environment jsdom

import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initialState, useStore } from "../store.js";
import { renderWithProviders } from "../test-utils.js";
import { MandateWizard } from "./MandateWizard.js";

const iso = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString();
const proposal = {
  ok: true,
  mandate: {
    max_total: "5.00",
    max_per_task: "2.00",
    expires_at: iso(12),
    allowed_categories: ["data-conversion"],
    allowed_payees: [{ name: "worker", id: `02${"ab".repeat(32)}` }],
    recurring: false,
    flags: [],
    needs_second_confirm: false,
  },
};
const reply = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));
const FUNDS = { ok: true, spendable: "50.00", reserved: "41.20", available_to_delegate: "8.80" };

let signBodies: Record<string, unknown>[];
function stub(funds: unknown = FUNDS, fundsStatus = 200) {
  signBodies = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: { body?: string }) => {
      if (url.includes("/api/goal")) return reply(proposal);
      if (url.includes("/api/funds")) return reply(funds, fundsStatus);
      if (url.includes("/sign-root")) {
        signBodies.push(JSON.parse(init?.body ?? "{}") as Record<string, unknown>);
        return reply({ ok: true, root: { signature: "9".repeat(130) } });
      }
      return reply({ ok: true, cap_hash: "c".repeat(64) });
    }),
  );
}
const connect = () =>
  useStore.setState({ principal: { status: "connected", id: `eip191:0x${"ab".repeat(20)}` } });
async function review() {
  renderWithProviders(<MandateWizard open onOpenChange={() => {}} />);
  await userEvent.type(screen.getByRole("textbox"), "Pay up to 5 tUSD to worker, within 12 hours");
  await userEvent.click(screen.getByRole("button", { name: /draft mandate/i }));
  await screen.findByTestId("ceiling-field");
}
const slider = () =>
  screen.getByRole("slider", { name: /spending ceiling slider/i }) as HTMLInputElement;
const amount = () =>
  screen.getByRole("textbox", { name: /spending ceiling \(tusd\)/i }) as HTMLInputElement;

beforeEach(() => history.pushState({}, "", "/"));
afterEach(() => {
  cleanup();
  useStore.setState({ ...initialState });
  vi.unstubAllGlobals();
});

describe("mandate dialog: ceiling and funds", () => {
  it("bounds the slider at the funds available to delegate", async () => {
    stub();
    connect();
    await review();
    await waitFor(() => expect(slider().max).toBe("880"));
    expect(slider().min).toBe("0");
    expect(screen.getByText("Available to delegate:", { exact: false }).textContent).toContain(
      "8.80",
    );
  });

  it("moving the slider rewrites the amount and the mandate that is shown", async () => {
    stub();
    connect();
    await review();
    await waitFor(() => expect(slider().max).toBe("880"));
    fireEvent.change(slider(), { target: { value: "300" } });
    expect(amount().value).toBe("3.00");
    expect(screen.getByText("3.00 tUSD")).toBeTruthy();
  });

  it("presets fill the amount: enough for N tasks of the per-task limit", async () => {
    stub();
    connect();
    await review();
    await userEvent.click(screen.getByRole("button", { name: /3 tasks of 2\.00/ }));
    expect(amount().value).toBe("6.00");
  });

  it("above the available funds it warns, and signing is still allowed with the typed ceiling", async () => {
    stub();
    connect();
    await review();
    await waitFor(() => expect(slider().max).toBe("880"));
    expect(screen.queryByText("More than you can delegate right now")).toBeNull();
    await userEvent.clear(amount());
    await userEvent.type(amount(), "20");
    expect(screen.getByText("More than you can delegate right now")).toBeTruthy();
    expect(slider().value).toBe("880");
    const approve = screen.getByRole("button", { name: /approve and sign/i }) as HTMLButtonElement;
    expect(approve.disabled).toBe(false);
    await userEvent.click(approve);
    expect(
      await screen.findByText(/signed by your principal key \(WDK, separate process\)/i),
    ).toBeTruthy();
    expect(signBodies[0]?.proposal).toMatchObject({ max_total: "20.00", max_per_task: "2.00" });
  });

  it("an invalid amount blocks signing and says why", async () => {
    stub();
    connect();
    await review();
    await userEvent.clear(amount());
    await userEvent.type(amount(), "0");
    expect(screen.getByRole("alert").textContent).toMatch(/above zero/);
    expect(
      (screen.getByRole("button", { name: /approve and sign/i }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("a ceiling below the per-task limit lowers the per-task limit with it", async () => {
    stub();
    connect();
    await review();
    await userEvent.clear(amount());
    await userEvent.type(amount(), "1.50");
    await userEvent.click(screen.getByRole("button", { name: /approve and sign/i }));
    await screen.findByText(/signed by your principal key/i);
    expect(signBodies[0]?.proposal).toMatchObject({ max_total: "1.50", max_per_task: "1.50" });
  });

  it("without a connected principal there is no funds call, no bound and no warning", async () => {
    stub();
    await review();
    await userEvent.clear(amount());
    await userEvent.type(amount(), "400");
    expect(screen.queryByText("More than you can delegate right now")).toBeNull();
    expect(vi.mocked(fetch).mock.calls.some(([u]) => String(u).includes("/api/funds"))).toBe(false);
    expect(
      (screen.getByRole("button", { name: /approve and sign/i }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("when the funds are unknown the warning stays off", async () => {
    stub({ ok: false, code: "FUNDS_UNAVAILABLE", message: "no wallet" }, 503);
    connect();
    await review();
    await userEvent.clear(amount());
    await userEvent.type(amount(), "400");
    expect(screen.queryByText("More than you can delegate right now")).toBeNull();
  });

  it("says that signing moves no funds, and shows the signature with a copy button once signed", async () => {
    stub();
    connect();
    await review();
    expect(
      screen.getByText("Signing sets a spending limit. No funds move until a task is paid."),
    ).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /approve and sign/i }));
    await screen.findByText(/signed by your principal key/i);
    expect(screen.getByRole("button", { name: "Copy signature" })).toBeTruthy();
    expect(screen.getByTitle("9".repeat(130))).toBeTruthy();
  });
});
