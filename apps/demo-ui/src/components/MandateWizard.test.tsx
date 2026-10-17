// @vitest-environment jsdom

import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { RootCapability } from "@verdict/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MOCK_EVENTS } from "../mock/events.js";
import { initialState, useStore } from "../store.js";
import { renderWithProviders } from "../test-utils.js";
import { EXAMPLES, MandateWizard } from "./MandateWizard.js";

const iso = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString();
const proposal = (hours: number, flagged: boolean) => ({
  ok: true,
  mandate: {
    max_total: "5.00",
    max_per_task: "2.00",
    expires_at: iso(hours),
    allowed_categories: ["data-conversion"],
    allowed_payees: [{ name: "worker", id: `02${"ab".repeat(32)}` }],
    recurring: false,
    flags: flagged
      ? [{ code: "AMOUNT_NOT_IN_GOAL", message: "Amount 5.00 is not in your text." }]
      : [],
    needs_second_confirm: flagged,
  },
});
const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));

let calls: { url: string; body: Record<string, unknown> }[];
function stubFetch(goal: unknown, signer: (n: number) => Promise<Response>) {
  calls = [];
  let n = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init: { body: string }) => {
      calls.push({ url, body: JSON.parse(init.body) as Record<string, unknown> });
      if (url.includes("/api/goal")) return json(goal);
      if (url.includes("/sign-root")) return signer(n++);
      return json({ ok: true, cap_hash: "c".repeat(64) });
    }),
  );
}
const signed = () => json({ ok: true, root: { signature: "9".repeat(128) } });
const needConfirm = () =>
  json(
    {
      ok: false,
      code: "SECOND_CONFIRM_REQUIRED",
      message: "Please confirm again.",
      confirm_token: "tok1",
    },
    428,
  );

async function draft(text: string) {
  renderWithProviders(<MandateWizard open onOpenChange={() => {}} />);
  await userEvent.type(screen.getByRole("textbox"), text);
  await userEvent.click(screen.getByRole("button", { name: /draft mandate/i }));
}

beforeEach(() => history.pushState({}, "", "/"));
afterEach(() => {
  cleanup();
  useStore.setState({ ...initialState });
  vi.unstubAllGlobals();
});

describe("MandateWizard", () => {
  it("validates the text and fills it from an example chip", async () => {
    renderWithProviders(<MandateWizard open onOpenChange={() => {}} />);
    await userEvent.type(screen.getByRole("textbox"), "ab");
    await userEvent.click(screen.getByRole("button", { name: /draft mandate/i }));
    expect(await screen.findByText("Write at least 3 characters.")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: EXAMPLES[0] as string }));
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(EXAMPLES[0]);
  });

  it("shows the review in plain language and signs in one click when nothing is flagged", async () => {
    stubFetch(proposal(12, false), signed);
    await draft("Pay up to 5 tUSD to worker, within 12 hours");
    expect(await screen.findByText("5.00 tUSD")).toBeTruthy();
    expect(screen.getByText("In 12 hours")).toBeTruthy();
    expect(screen.getByText("data-conversion")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /approve and sign/i }));
    expect(await screen.findByText(/signed by the principal \(separate process\)/i)).toBeTruthy();
    expect(calls.filter((c) => c.url.includes("/sign-root"))).toHaveLength(1);
  });

  it("blocks approve and explains it when the duration is below what a task needs", async () => {
    stubFetch(proposal(1, false), signed);
    await draft("Pay up to 5 tUSD to worker, within 1 hour");
    expect(await screen.findByText("Too short for one task")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: /approve and sign/i }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("needs the box ticked when the buyer flags an amount, then follows the signer's 428 token", async () => {
    stubFetch(proposal(12, true), (n) => (n === 0 ? needConfirm() : signed()));
    await draft("Convert my csv");
    const approve = await screen.findByRole("button", { name: /approve and sign/i });
    expect((approve as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(screen.getByRole("checkbox"));
    await userEvent.click(approve);
    expect(await screen.findByText(/signed by the principal/i)).toBeTruthy();
    const sign = calls.filter((c) => c.url.includes("/sign-root"));
    expect(sign).toHaveLength(2);
    expect(sign[0]?.body.confirm_token).toBeUndefined();
    expect(sign[1]?.body.confirm_token).toBe("tok1");
  });

  it("asks for a second confirmation when only the signer finds the mandate unusual", async () => {
    stubFetch(proposal(12, false), (n) => (n === 0 ? needConfirm() : signed()));
    await draft("Pay up to 5 tUSD to worker, within 12 hours");
    await userEvent.click(await screen.findByRole("button", { name: /approve and sign/i }));
    expect(await screen.findByText(/Please confirm again\./)).toBeTruthy();
    const approve = screen.getByRole("button", { name: /approve and sign/i });
    expect((approve as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(screen.getByRole("checkbox"));
    await userEvent.click(approve);
    await waitFor(() => expect(screen.getByText(/signed by the principal/i)).toBeTruthy());
    const sign = calls.filter((c) => c.url.includes("/sign-root"));
    expect(sign[1]?.body.confirm_token).toBe("tok1");
  });
});

describe("MandateWizard replacing a mandate", () => {
  const root = MOCK_EVENTS.find((e) => e.type === "CAP_ROOT")?.data as RootCapability;
  it("says the current mandate is replaced when a root is active", async () => {
    useStore.setState({ root: { ...root, expires_at: iso(5) } });
    stubFetch(proposal(12, false), signed);
    await draft("Pay up to 5 tUSD to worker, within 12 hours");
    expect(
      await screen.findByText(/^Replaces the current mandate\. Unused budget returns/),
    ).toBeTruthy();
    expect(screen.queryByText(/previous mandate expired/)).toBeNull();
  });
  it("says the previous mandate expired when the root has expired", async () => {
    useStore.setState({ root: { ...root, expires_at: iso(-2) } });
    stubFetch(proposal(12, false), signed);
    await draft("Pay up to 5 tUSD to worker, within 12 hours");
    expect(await screen.findByText("The previous mandate expired.")).toBeTruthy();
    expect(screen.queryByText(/Replaces the current mandate/)).toBeNull();
  });
  it("shows no such line for the first mandate", async () => {
    stubFetch(proposal(12, false), signed);
    await draft("Pay up to 5 tUSD to worker, within 12 hours");
    await screen.findByText("5.00 tUSD");
    expect(screen.queryByText(/Replaces the current mandate/)).toBeNull();
  });
  it("renders an engine refusal in place with its message and code", async () => {
    useStore.setState({ root: { ...root, expires_at: iso(5) } });
    stubFetch(proposal(12, false), signed);
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url.includes("/api/goal")) return json(proposal(12, false));
        if (url.includes("/sign-root")) return signed();
        return json({ ok: false, code: "ROOT_EXISTS", message: "A mandate already exists." }, 409);
      }),
    );
    await draft("Pay up to 5 tUSD to worker, within 12 hours");
    await userEvent.click(await screen.findByRole("button", { name: /approve and sign/i }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/A mandate already exists\./);
    expect(alert.textContent).toMatch(/ROOT_EXISTS/);
    expect(screen.getByRole("button", { name: /approve and sign/i })).toBeTruthy();
  });
});
