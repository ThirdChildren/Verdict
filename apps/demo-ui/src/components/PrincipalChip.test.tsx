// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { principalChip, shortPrincipal } from "../lib/principal.js";
import { initialState, useStore } from "../store.js";
import { PrincipalChip } from "./PrincipalChip.js";

const ID = `eip191:0x${"ab".repeat(18)}cdef`;
const reply = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));

beforeEach(() => {
  history.pushState({}, "", "/");
  sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  useStore.setState({ ...initialState });
  vi.unstubAllGlobals();
});

describe("principal chip text", () => {
  it("shows the scheme and the last four characters", () => {
    expect(shortPrincipal(ID)).toBe("eip191:0x…cdef");
    expect(principalChip(ID)).toBe("Principal · WDK · eip191:0x…cdef · regtest");
  });
});

describe("PrincipalChip", () => {
  it("starts as a Connect principal button and fetches the id through the engine", async () => {
    const fetchMock = vi.fn((_url: string) => reply({ ok: true, id: ID }));
    vi.stubGlobal("fetch", fetchMock);
    render(<PrincipalChip />);
    await userEvent.click(screen.getByRole("button", { name: "Connect principal" }));
    expect(await screen.findByText(/Principal · WDK · eip191:0x…cdef · regtest/)).toBeTruthy();
    expect(useStore.getState().principal).toEqual({ status: "connected", id: ID });
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/api/principal");
    expect(screen.queryByRole("button", { name: "Connect principal" })).toBeNull();
  });

  it("shows a clear error state when the signer is down, and retries", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() =>
        reply(
          {
            ok: false,
            code: "PRINCIPAL_SIGNER_DOWN",
            message: "The principal signer is not running.",
          },
          502,
        ),
      )
      .mockImplementation(() => reply({ ok: true, id: ID }));
    vi.stubGlobal("fetch", fetchMock);
    render(<PrincipalChip />);
    await userEvent.click(screen.getByRole("button", { name: "Connect principal" }));
    const retry = await screen.findByRole("button", { name: /principal unreachable/i });
    expect(retry.getAttribute("title")).toBe("The principal signer is not running.");
    expect(useStore.getState().principal).toEqual({
      status: "error",
      message: "The principal signer is not running.",
    });
    await userEvent.click(retry);
    await waitFor(() => expect(useStore.getState().principal.status).toBe("connected"));
  });

  it("stays connected when the event stream resets, and is remembered for the session", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => reply({ ok: true, id: ID })),
    );
    render(<PrincipalChip />);
    await userEvent.click(screen.getByRole("button", { name: "Connect principal" }));
    await screen.findByText(/Principal · WDK/);
    useStore.getState().reset();
    expect(useStore.getState().principal).toEqual({ status: "connected", id: ID });
    expect(sessionStorage.getItem("verdict.principal")).toBe("1");
  });

  it("treats an unreachable engine as an error, never as connected", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new TypeError("fetch failed"))),
    );
    render(<PrincipalChip />);
    await userEvent.click(screen.getByRole("button", { name: "Connect principal" }));
    expect(await screen.findByRole("button", { name: /principal unreachable/i })).toBeTruthy();
    expect(useStore.getState().principal.status).toBe("error");
    expect(sessionStorage.getItem("verdict.principal")).toBeNull();
  });
});
