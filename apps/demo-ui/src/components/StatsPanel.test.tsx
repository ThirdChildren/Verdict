// @vitest-environment jsdom

import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setStatsOpen } from "../lib/statsPanel.js";
import { glyphBar } from "../lib/statsView.js";
import { parseStats } from "../lib/verifierApi.js";
import { renderWithProviders } from "../test-utils.js";
import { StatsBody, StatsPanel } from "./StatsPanel.js";
import { VerifierLane } from "./VerifierLane.js";

const row = (over: Record<string, unknown> = {}) => ({
  package_sha256: `3f9a${"0".repeat(60)}`,
  package_id: "csv2json-v1",
  format: 1,
  runs: 12,
  pass_rate: 0.75,
  mean_score: null,
  median_duration_ms: 4300,
  determinism_rate: 1,
  self_check_agreement: 0.92,
  checks: [{ id: "tests", runs: 12, fail_rate: 0.25 }],
  withhold_codes: { VERIFY_TIMEOUT: 1 },
  extra_field: true,
  ...over,
});

afterEach(() => {
  setStatsOpen(false);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("parseStats", () => {
  it("skips malformed rows with a warning and ignores unknown fields", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = parseStats({ packages: [row(), { package_id: 5 }, row({ pass_rate: 4 })] });
    expect(out).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(2);
  });
});

describe("glyphBar", () => {
  it("is ten cells of ink glyphs", () => {
    expect(glyphBar(0.25)).toBe("■■■□□□□□□□");
    expect(glyphBar(0)).toBe("□□□□□□□□□□");
    expect(glyphBar(1)).toBe("■■■■■■■■■■");
  });
});

describe("StatsBody", () => {
  it("shows a package row, expands to checks and lists withhold codes", async () => {
    renderWithProviders(<StatsBody rows={parseStats({ packages: [row()] })} />);
    expect(screen.getByText("csv2json-v1")).toBeTruthy();
    expect(screen.getByText("75%")).toBeTruthy();
    expect(screen.getByText("—")).toBeTruthy();
    expect(screen.getByText("4.3 s")).toBeTruthy();
    expect(screen.getByText("VERIFY_TIMEOUT 1")).toBeTruthy();
    expect(screen.queryByText("■■■□□□□□□□")).toBeNull();
    await userEvent.click(screen.getByRole("button", { expanded: false }));
    expect(screen.getByText("■■■□□□□□□□")).toBeTruthy();
    expect(screen.getByText("tests")).toBeTruthy();
  });
});

describe("StatsPanel", () => {
  it("loads, shows the caption, and s closes it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response(JSON.stringify({ packages: [row()] })))),
    );
    renderWithProviders(<StatsPanel />);
    setStatsOpen(true);
    await waitFor(() => expect(screen.getByText("csv2json-v1")).toBeTruthy());
    expect(screen.getByText(/how well workers predict them/)).toBeTruthy();
    await userEvent.keyboard("s");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("says so when the verifier is down", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("down"))),
    );
    renderWithProviders(<StatsPanel />);
    setStatsOpen(true);
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
  });
});

describe("VerifierLane verdict", () => {
  it("shows the score line and labels a failed check inside a RELEASE as advisory", async () => {
    const report = {
      record: {
        task_id: "t",
        attempt: 1,
        verdict: "RELEASE",
        exit_code: 0,
        verifier_package_sha256: "a".repeat(64),
        delivery_sha256: "b".repeat(64),
        verifier_sig: "c".repeat(128),
        checks: [
          { id: "tests", status: "PASS" },
          { id: "style", status: "FAIL" },
        ],
      },
      outcome: "PASS",
      code: null,
      message: "",
      sandbox: "docker",
      log_tail: [],
      verify_sh_sha256: "d".repeat(64),
      seconds: 3,
      v2: { score: 87, min_score: 80, profile: "standard" },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              tasks: [{ task_id: "t", payment_hash: "p", released: true, reports: [report] }],
            }),
          ),
        ),
      ),
    );
    renderWithProviders(<VerifierLane />);
    await waitFor(() => expect(screen.getByText("advisory")).toBeTruthy());
    expect(screen.getByText(/87 \/ 80/)).toBeTruthy();
    expect(screen.getByText("standard")).toBeTruthy();
  });
});
