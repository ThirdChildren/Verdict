// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

class RO {
  observe() {}
  unobserve() {}
  disconnect() {}
}
let Root: typeof import("./components/Providers.js").Providers;
let App: typeof import("./App.js").App;

beforeAll(async () => {
  globalThis.ResizeObserver ??= RO;
  history.pushState({}, "", "/?mock=1");
  Root = (await import("./components/Providers.js")).Providers;
  App = (await import("./App.js")).App;
});
afterEach(cleanup);

describe("App in mock mode", () => {
  it("shows the MOCK DATA banner, the top bar and the storyboard", async () => {
    render(
      <Root>
        <App />
      </Root>,
    );
    expect(screen.getByText(/MOCK DATA/)).toBeTruthy();
    expect(screen.getByText("regtest · tUSD")).toBeTruthy();
    expect(screen.getByLabelText("Storyboard")).toBeTruthy();
    // No mandate yet in the first frame: the empty state offers the one action.
    expect(await screen.findByRole("button", { name: "Create mandate" })).toBeTruthy();
  });
  it("switches to a blocked scene and explains it", async () => {
    render(
      <Root>
        <App />
      </Root>,
    );
    await userEvent.selectOptions(screen.getByLabelText("Storyboard"), "blocked");
    expect(
      (await screen.findAllByText(/Nothing was signed\. No funds moved\./)).length,
    ).toBeGreaterThan(0);
    expect(screen.getAllByText("Blocked").length).toBeGreaterThan(0);
  });
  it("mock new mandate: the word opens the wizard and the canned signing shows the new ceiling", async () => {
    render(
      <Root>
        <App />
      </Root>,
    );
    expect(screen.queryByRole("button", { name: /new mandate/i })).toBeNull();
    await userEvent.selectOptions(screen.getByLabelText("Storyboard"), "second-mandate");
    await userEvent.click(await screen.findByRole("button", { name: /new mandate/i }));
    await userEvent.type(
      screen.getByRole("textbox"),
      "Pay up to 7 tUSD to worker to convert CSV, within 12 hours",
    );
    await userEvent.click(screen.getByRole("button", { name: /draft mandate/i }));
    expect(await screen.findByText(/^Replaces the current mandate\./)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /approve and sign/i }));
    expect(await screen.findByText(/signed by the principal/i)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /start working/i }));
    expect((await screen.findAllByText(/mandate retired/i)).length).toBeGreaterThan(0);
  });
  it("mock first mandate: signing puts the mandate on screen and n opens New task", async () => {
    render(
      <Root>
        <App />
      </Root>,
    );
    await userEvent.click(await screen.findByRole("button", { name: "Create mandate" }));
    await userEvent.type(
      screen.getByRole("textbox"),
      "Pay up to 5 tUSD to worker to convert CSV, within 12 hours",
    );
    await userEvent.click(screen.getByRole("button", { name: /draft mandate/i }));
    await userEvent.click(await screen.findByRole("button", { name: /approve and sign/i }));
    await userEvent.click(await screen.findByRole("button", { name: /start working/i }));
    expect((await screen.findAllByText(/Mandate · /)).length).toBeGreaterThan(0);
    expect(document.activeElement?.textContent).toMatch(/new task/i);
    await userEvent.keyboard("{Escape}");
    await userEvent.keyboard("n");
    expect(await screen.findByRole("dialog", { name: "New task" })).toBeTruthy();
  });
  it("Esc closes the demo console", async () => {
    render(
      <Root>
        <App />
      </Root>,
    );
    await vi.waitFor(async () => {
      await userEvent.keyboard("d");
      expect(screen.queryByRole("complementary", { name: "Demo console" })).not.toBeNull();
    });
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("complementary", { name: "Demo console" })).toBeNull();
  });
  it("toggles dark mode on <html> so portalled dialogs follow it", async () => {
    render(
      <Root>
        <App />
      </Root>,
    );
    await userEvent.click(screen.getByRole("button", { name: /dark theme/ }));
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });
  it("opens the shortcut help with ? and lists every shortcut", async () => {
    render(
      <Root>
        <App />
      </Root>,
    );
    await userEvent.keyboard("?");
    const dialog = await screen.findByRole("dialog", { name: "Keyboard shortcuts" });
    for (const what of [/New task/, /Inspector/, /Demo console/, /Presenter size/, /Next task/])
      expect(within(dialog).getByText(what)).toBeTruthy();
  });
  it("toggles presenter size and the inspector from the keyboard", async () => {
    render(
      <Root>
        <App />
      </Root>,
    );
    await userEvent.keyboard("p");
    expect(document.documentElement.classList.contains("presenter")).toBe(true);
    await userEvent.keyboard("p");
    expect(document.documentElement.classList.contains("presenter")).toBe(false);
    await userEvent.keyboard("i");
    expect(await screen.findByRole("tab", { name: /proof/i })).toBeTruthy();
  });
  it("toggles the demo console with d (mock mode enables it)", async () => {
    render(
      <Root>
        <App />
      </Root>,
    );
    expect(screen.queryByRole("complementary", { name: "Demo console" })).toBeNull();
    // The toggles answer arrives asynchronously; the key works once the console registered.
    await vi.waitFor(async () => {
      await userEvent.keyboard("d");
      expect(screen.queryByRole("complementary", { name: "Demo console" })).not.toBeNull();
    });
    await userEvent.keyboard("d");
    expect(screen.queryByRole("complementary", { name: "Demo console" })).toBeNull();
  });
});
