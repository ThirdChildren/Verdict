// @vitest-environment jsdom

import { act, cleanup, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initialState, useStore } from "../store.js";
import { renderWithProviders } from "../test-utils.js";
import { FundsPanel } from "./FundsPanel.js";

const reply = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));
const ID = `eip191:0x${"ab".repeat(20)}`;
const funds = (spendable: string, reserved: string, avail: string) => ({
  ok: true,
  spendable,
  reserved,
  available_to_delegate: avail,
});

beforeEach(() => history.pushState({}, "", "/"));
afterEach(() => {
  cleanup();
  useStore.setState({ ...initialState });
  vi.unstubAllGlobals();
});

describe("FundsPanel", () => {
  it("renders nothing until a principal is connected, and never calls the engine", () => {
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    const { container } = renderWithProviders(<FundsPanel />);
    expect(container.textContent).toBe("");
    expect(f).not.toHaveBeenCalled();
  });

  it("shows the three figures as the engine sent them, under the regtest label", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => reply(funds("50.00", "1.20", "48.80"))),
    );
    useStore.setState({ principal: { status: "connected", id: ID } });
    renderWithProviders(<FundsPanel />);
    expect(screen.getByText("Regtest test asset (tUSD)")).toBeTruthy();
    expect(await screen.findByText("50.00")).toBeTruthy();
    expect(screen.getByText("1.20")).toBeTruthy();
    expect(screen.getByText("48.80")).toBeTruthy();
    expect(screen.getByText("Available to delegate")).toBeTruthy();
  });

  it("refetches when a payment status event changes the store", async () => {
    let n = 0;
    const f = vi.fn(() =>
      reply(n++ === 0 ? funds("50.00", "1.20", "48.80") : funds("47.00", "1.20", "45.80")),
    );
    vi.stubGlobal("fetch", f);
    useStore.setState({ principal: { status: "connected", id: ID } });
    renderWithProviders(<FundsPanel />);
    await screen.findByText("50.00");
    act(() => useStore.setState({ payments: { [`${"a".repeat(64)}`]: "Pending" } }));
    expect(await screen.findByText("47.00")).toBeTruthy();
    expect(screen.getByText("45.80")).toBeTruthy();
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("says so when the engine cannot report funds, without inventing a number", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        reply(
          {
            ok: false,
            code: "FUNDS_UNAVAILABLE",
            message: "The engine is running without a wallet.",
          },
          503,
        ),
      ),
    );
    useStore.setState({ principal: { status: "connected", id: ID } });
    renderWithProviders(<FundsPanel />);
    expect(await screen.findByText(/running without a wallet/)).toBeTruthy();
    expect(screen.queryByText("Spendable in channel")).toBeNull();
  });

  it("shows the connect error with a retry when the principal is unreachable", () => {
    useStore.setState({
      principal: { status: "error", message: "The principal signer is not running." },
    });
    renderWithProviders(<FundsPanel />);
    expect(screen.getByRole("alert").textContent).toContain("The principal signer is not running.");
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });
});
