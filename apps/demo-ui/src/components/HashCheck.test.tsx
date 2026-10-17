// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { sha256Hex } from "@verdict/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { HashCheck } from "./HashCheck.js";

afterEach(cleanup);
const h = sha256Hex("hello");

describe("HashCheck", () => {
  it("says verified when the recomputed hash matches", () => {
    render(<HashCheck label="Delivery" shown={h} recomputed={sha256Hex("hello")} />);
    expect(screen.getByText("verified in your browser")).toBeTruthy();
    expect(screen.queryByText(/MISMATCH/)).toBeNull();
  });
  it("says MISMATCH when it differs", () => {
    render(<HashCheck label="Delivery" shown={h} recomputed={sha256Hex("tampered")} />);
    expect(screen.getByText(/MISMATCH/)).toBeTruthy();
    expect(screen.queryByText("verified in your browser")).toBeNull();
  });
  it("does not claim verification when data is missing", () => {
    render(<HashCheck label="Delivery" shown={h} recomputed={null} />);
    expect(screen.queryByText("verified in your browser")).toBeNull();
  });
});
