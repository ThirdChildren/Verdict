// @vitest-environment jsdom

import { cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
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
        onToggleInspector={() => {}}
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
