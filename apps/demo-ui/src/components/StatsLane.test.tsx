// @vitest-environment jsdom

import { cleanup, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchVerifierStats } from "../mock/api.js";
import { renderWithProviders } from "../test-utils.js";
import { StatsBody } from "./StatsPanel.js";
import { VerifierLane } from "./VerifierLane.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("StatsBody with the mock packages", () => {
  it("renders both mock packages", async () => {
    const rows = await fetchVerifierStats();
    expect(rows.map((r) => r.package_id)).toEqual(["csv2json-v1", "json-normalise-v1"]);
    renderWithProviders(<StatsBody rows={rows} />);
    expect(screen.getByText("csv2json-v1")).toBeTruthy();
    expect(screen.getByText("json-normalise-v1")).toBeTruthy();
    expect(screen.getByText("75%")).toBeTruthy();
    expect(screen.getByText("80%")).toBeTruthy();
  });
});

function lane(verdict: "RELEASE" | "WITHHOLD", v2: Record<string, unknown> | undefined) {
  const report = {
    record: {
      task_id: "t",
      attempt: 1,
      verdict,
      exit_code: verdict === "RELEASE" ? 0 : 1,
      verifier_package_sha256: "a".repeat(64),
      delivery_sha256: "b".repeat(64),
      verifier_sig: "c".repeat(128),
      checks: [
        { id: "tests", status: "PASS" },
        { id: "style", status: "FAIL" },
      ],
    },
    outcome: verdict === "RELEASE" ? "PASS" : "FAIL",
    code: null,
    message: "",
    sandbox: "docker",
    log_tail: [],
    verify_sh_sha256: "d".repeat(64),
    seconds: 3,
    ...(v2 ? { v2 } : {}),
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
}

describe("VerifierLane score and advisory label", () => {
  it("shows no SCORE line when min_score is missing", async () => {
    lane("RELEASE", { score: 87, min_score: null, profile: "standard" });
    await waitFor(() => expect(screen.getByText(/style: failed/)).toBeTruthy());
    expect(screen.queryByText(/Score/)).toBeNull();
  });

  it("shows no SCORE line when score is missing, or for a v1 report without v2", async () => {
    lane("RELEASE", { score: null, min_score: 80, profile: null });
    await waitFor(() => expect(screen.getByText(/style: failed/)).toBeTruthy());
    expect(screen.queryByText(/Score/)).toBeNull();
  });

  it("shows no SCORE line for a v1 report", async () => {
    lane("RELEASE", undefined);
    await waitFor(() => expect(screen.getByText(/style: failed/)).toBeTruthy());
    expect(screen.queryByText(/Score/)).toBeNull();
  });

  it("labels the failed check advisory in a RELEASE record", async () => {
    lane("RELEASE", { score: 87, min_score: 80, profile: "standard" });
    await waitFor(() => expect(screen.getByText("advisory")).toBeTruthy());
  });

  it("does not label the failed check advisory in a WITHHOLD record", async () => {
    lane("WITHHOLD", { score: 40, min_score: 80, profile: "standard" });
    await waitFor(() => expect(screen.getByText(/style: failed/)).toBeTruthy());
    expect(screen.queryByText("advisory")).toBeNull();
  });
});
