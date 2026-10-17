// @vitest-environment jsdom

import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { RootCapability } from "@verdict/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MOCK_EVENTS } from "../mock/events.js";
import { type AppState, initialState } from "../store.js";
import { renderWithProviders as render } from "../test-utils.js";
import { ThemeProvider } from "./ThemeProvider.js";
import { TopBar } from "./TopBar.js";

afterEach(cleanup);
const bar = (connections: AppState["connections"]) =>
  render(
    <ThemeProvider>
      <TopBar
        state={{ ...initialState, connections }}
        root={null}
        inspectorOpen={false}
        presenter={false}
        onTogglePresenter={() => {}}
        onHelp={() => {}}
        onReconnect={() => {}}
        onMandate={() => {}}
        onNewMandate={() => {}}
        onToggleInspector={() => {}}
        onAgents={() => {}}
      />
    </ThemeProvider>,
  );

describe("services pill", () => {
  it("counts connected services in one pill", () => {
    bar({ engine: "connected", worker: "connected", verifier: "connected" });
    expect(screen.getByRole("button", { name: "Services 3 of 3 connected" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /reconnect/i })).toBeNull();
  });
  it("names the service that is down and offers Reconnect", () => {
    bar({ engine: "connected", worker: "connected", verifier: "disconnected" });
    expect(screen.getByText(/Verifier down/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /reconnect/i })).toBeTruthy();
  });
});

describe("new mandate word", () => {
  const root = MOCK_EVENTS.find((e) => e.type === "CAP_ROOT")?.data as RootCapability;
  const barWith = (r: RootCapability | null, onNewMandate = () => {}) =>
    render(
      <ThemeProvider>
        <TopBar
          state={initialState}
          root={r}
          inspectorOpen={false}
          presenter={false}
          onTogglePresenter={() => {}}
          onHelp={() => {}}
          onReconnect={() => {}}
          onMandate={() => {}}
          onNewMandate={onNewMandate}
          onToggleInspector={() => {}}
          onAgents={() => {}}
        />
      </ThemeProvider>,
    );
  it("is absent without a root", () => {
    barWith(null);
    expect(screen.queryByRole("button", { name: /new mandate/i })).toBeNull();
  });
  it("is present with an active or expired root and opens the wizard", async () => {
    const open = vi.fn();
    barWith(root, open);
    await userEvent.click(screen.getByRole("button", { name: /new mandate/i }));
    expect(open).toHaveBeenCalledTimes(1);
    cleanup();
    barWith({ ...root, expires_at: "2020-01-01T00:00:00Z" });
    expect(screen.getByRole("button", { name: /new mandate/i })).toBeTruthy();
    expect(screen.getAllByText(/Mandate expired/).length).toBeGreaterThan(0);
  });
});
