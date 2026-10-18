// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
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
    expect(await screen.findByText(/signed by your principal key/i)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /start working/i }));
    const list = await screen.findByRole("navigation", { name: "Mandates" });
    expect(within(list).getByText(/retired/i)).toBeTruthy();
    expect(within(list).getAllByRole("button")).toHaveLength(2);
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

describe("mandate history in mock mode", () => {
  const mount = async () => {
    render(
      <Root>
        <App />
      </Root>,
    );
    await userEvent.selectOptions(screen.getByLabelText("Storyboard"), "mandates-history");
    return screen.findByRole("navigation", { name: "Mandates" });
  };
  it("lists both mandates newest first, rebuilt from the mock API, and scopes the rail to the active one", async () => {
    const list = await mount();
    await waitFor(() => expect(within(list).getAllByRole("button")).toHaveLength(2));
    const [b, a] = within(list).getAllByRole("button");
    expect(b?.textContent).toMatch(/02.*ACTIVE.*1 task.*5\.00 · 2\.00\/task/);
    expect(a?.textContent).toMatch(/01.*RETIRED.*2 tasks.*5\.00/);
    expect(b?.getAttribute("aria-current")).toBe("true");
    const rail = screen.getByRole("navigation", { name: "Tasks" });
    expect(within(rail).getAllByRole("button")).toHaveLength(1);
  });
  it("a retired mandate is read-only: its tasks and frozen figures show, NEW TASK says why", async () => {
    const list = await mount();
    await waitFor(() => expect(within(list).getAllByRole("button")).toHaveLength(2));
    await userEvent.click(within(list).getAllByRole("button")[1] as HTMLElement);
    const rail = screen.getByRole("navigation", { name: "Tasks" });
    expect(within(rail).getAllByRole("button")).toHaveLength(2);
    expect(within(rail).getByText("Paid")).toBeTruthy();
    expect(within(rail).getByText("Refunded")).toBeTruthy();
    expect(screen.getByText(/At retirement/)).toBeTruthy();
    const newTask = screen.getByRole("button", { name: "New task" }) as HTMLButtonElement;
    expect(newTask.disabled).toBe(true);
    expect(
      screen.getByText("This mandate is retired. Select the active one or create a new mandate."),
    ).toBeTruthy();
    await userEvent.click(document.body);
    // The key does nothing while the mandate is read-only.
    await userEvent.keyboard("n");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("[ and ] move between mandates", async () => {
    const list = await mount();
    await waitFor(() => expect(within(list).getAllByRole("button")).toHaveLength(2));
    await userEvent.click(document.body);
    await userEvent.keyboard("]");
    expect(within(list).getAllByRole("button")[1]?.getAttribute("aria-current")).toBe("true");
    await userEvent.keyboard("[[");
    expect(within(list).getAllByRole("button")[0]?.getAttribute("aria-current")).toBe("true");
  });
});
