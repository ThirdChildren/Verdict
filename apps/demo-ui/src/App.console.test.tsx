// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

class RO {
  observe() {}
  unobserve() {}
  disconnect() {}
}
class WS {
  onopen = null;
  onmessage = null;
  onclose = null;
  onerror = null;
  close() {}
}
let Root: typeof import("./components/Providers.js").Providers;
let App: typeof import("./App.js").App;

beforeAll(async () => {
  globalThis.ResizeObserver ??= RO;
  vi.stubGlobal("WebSocket", WS);
  history.pushState({}, "", "/");
  Root = (await import("./components/Providers.js")).Providers;
  App = (await import("./App.js")).App;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.stubGlobal("WebSocket", WS);
});

const answer = (enabled: boolean) =>
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      String(url).includes("/api/demo/toggles")
        ? new Response(JSON.stringify({ enabled }))
        : new Response("{}", { status: 503 }),
    ),
  );

describe("demo console gating (live mode)", () => {
  it("stays hidden and ignores d when the engine does not enable the toggles", async () => {
    answer(false);
    render(
      <Root>
        <App />
      </Root>,
    );
    await new Promise((r) => setTimeout(r, 100));
    await userEvent.keyboard("d");
    expect(screen.queryByRole("complementary", { name: "Demo console" })).toBeNull();
  });
  it("appears with d when the engine enables the toggles", async () => {
    answer(true);
    render(
      <Root>
        <App />
      </Root>,
    );
    await vi.waitFor(async () => {
      await userEvent.keyboard("d");
      expect(screen.queryByRole("complementary", { name: "Demo console" })).not.toBeNull();
    });
  });
});
