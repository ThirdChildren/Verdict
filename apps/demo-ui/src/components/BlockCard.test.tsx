// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { BLOCK_CODES, BLOCK_TEMPLATES } from "@verdict/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { BLOCK_TITLES } from "../lib/blocks.js";
import { BlockCard } from "./BlockCard.js";

afterEach(cleanup);

describe("BlockCard", () => {
  it.each(BLOCK_CODES)(
    "renders %s with its message verbatim, a title and a reassurance",
    (code) => {
      const message = BLOCK_TEMPLATES[code].replace(/\{[a-z_]+\}/g, "X");
      render(<BlockCard code={code} message={message} />);
      expect(screen.getByRole("alert").textContent).toContain(
        message.replace(/\s*Nothing was signed and no funds moved\.$/, ""),
      );
      expect(screen.getByRole("alert").textContent).toContain(BLOCK_TITLES[code]);
      expect(screen.getByRole("alert").textContent).toMatch(
        /No funds moved|No payment was released/,
      );
    },
  );
  it("shows the reassurance once", () => {
    render(
      <BlockCard
        code="COUNTERPARTY_NOT_ALLOWED"
        message="Bad payee. Nothing was signed and no funds moved."
      />,
    );
    expect(screen.getByRole("alert").textContent?.match(/Nothing was signed/gi)).toHaveLength(1);
  });
  it("pre-payment blocks say nothing was signed", () => {
    render(<BlockCard code="AMOUNT_EXCEEDS_PER_TASK" message="m" />);
    expect(screen.getByText("Nothing was signed. No funds moved.")).toBeTruthy();
  });
});
