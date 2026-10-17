// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { contractHash, dirHash, type VerdictRecord } from "@verdict/protocol";
import { afterEach, describe, expect, it } from "vitest";
import type { Evidence } from "../lib/api.js";
import { newTaskBlocker } from "./NewTaskButton.js";
import { Timeline } from "./PaymentTimeline.js";
import { EvidenceChecks } from "./ProofTab.js";

afterEach(cleanup);

const contract = { price: "1.20", signature: "0xabc" };
const files = [{ path: "out.json", content: "a,b\n1,2" }];
const dh = dirHash(
  files.map((f) => ({ path: f.path, bytes: new TextEncoder().encode(f.content) })),
);
const verdict = (over: Partial<VerdictRecord> = {}): VerdictRecord => ({
  task_id: "task_0123456789abcdef",
  contract_sha256: contractHash(contract),
  delivery_sha256: dh,
  verifier_package_sha256: "3".repeat(64),
  attempt: 1,
  checks: [],
  exit_code: 0,
  verdict: "RELEASE",
  payment_hash: "f".repeat(64),
  timestamp: 1,
  verifier_sig: "2".repeat(128),
  ...over,
});
const ev = (over: Partial<Evidence> = {}): Evidence => ({
  task_id: "task_0123456789abcdef",
  contract,
  contract_sha256: contractHash(contract),
  delivery: { files, sha256: dh },
  verdict: verdict(),
  ...over,
});

describe("EvidenceChecks", () => {
  it("verifies contract, delivery and verdict links", () => {
    render(<EvidenceChecks ev={ev()} />);
    expect(screen.getAllByText("verified in your browser")).toHaveLength(3);
  });
  it("flags a tampered delivery and the verdict that no longer matches it", () => {
    render(
      <EvidenceChecks
        ev={ev({ delivery: { files: [{ path: "out.json", content: "evil" }], sha256: dh } })}
      />,
    );
    expect(screen.getAllByText(/MISMATCH/).length).toBe(2);
  });
  it("flags a verdict that names another contract", () => {
    render(<EvidenceChecks ev={ev({ verdict: verdict({ contract_sha256: "9".repeat(64) }) })} />);
    expect(screen.getAllByText(/MISMATCH/)).toHaveLength(1);
  });
});

describe("Timeline", () => {
  it("shows a time for each reached state", () => {
    render(
      <Timeline
        history={[
          { status: "Pending", at: "2026-10-18T14:45:00Z" },
          { status: "Claimable", at: "2026-10-18T14:46:00Z" },
        ]}
      />,
    );
    expect(screen.getAllByText("not yet")).toHaveLength(1);
  });
  it("replaces Succeeded by Failed", () => {
    render(<Timeline history={[{ status: "Failed", at: "2026-10-18T14:45:00Z" }]} />);
    expect(screen.getByText("Failed")).toBeTruthy();
    expect(screen.queryByText("Succeeded")).toBeNull();
  });
});

describe("newTaskBlocker", () => {
  it("explains missing mandate and exhausted budget, else allows", () => {
    expect(newTaskBlocker(false, null, 2)).toMatch(/Sign a mandate/);
    expect(newTaskBlocker(true, "0.00", 2)).toMatch(/used up/);
    expect(newTaskBlocker(true, "1.00", 2)).toBeNull();
    expect(newTaskBlocker(true, null, 2)).toBeNull();
  });
});
