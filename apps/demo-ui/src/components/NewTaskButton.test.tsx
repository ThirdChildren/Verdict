// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
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
