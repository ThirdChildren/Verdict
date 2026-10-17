import { describe, expect, it } from "vitest";
import { mineErrorText, parseMineEvent, ringWithMining } from "./mine.js";

const data = { task_id: "t", height: 150, target_height: 200, percent: 50, state: "mining" };

describe("mine progress", () => {
  it("parses a DEMO_MINE_PROGRESS frame and ignores everything else", () => {
    expect(
      parseMineEvent(JSON.stringify({ seq: 1, at: "x", type: "DEMO_MINE_PROGRESS", data }))?.height,
    ).toBe(150);
    expect(parseMineEvent(JSON.stringify({ type: "BUDGET_UPDATED", data: {} }))).toBeNull();
    expect(parseMineEvent("not json")).toBeNull();
    expect(
      parseMineEvent({ type: "DEMO_MINE_PROGRESS", data: { ...data, state: "x" } }),
    ).toBeNull();
  });
  it("lets the mining height drive the block ring", () => {
    const p = parseMineEvent({ type: "DEMO_MINE_PROGRESS", data });
    expect(ringWithMining({ height: 100, lockedAt: 100, expiresAt: 190 }, p ?? undefined)).toEqual({
      height: 150,
      lockedAt: 100,
      expiresAt: 200,
    });
    expect(ringWithMining(null, p ?? undefined)?.lockedAt).toBe(100);
    expect(ringWithMining(null, undefined)).toBeNull();
  });
  it("explains every refusal code in plain language", () => {
    for (const c of [
      "DEMO_LOCAL_ONLY",
      "DEMO_BAD_REQUEST",
      "DEMO_TASK_UNKNOWN",
      "DEMO_ALREADY_MINING",
      "DEMO_OTHER_PAYMENT_IN_FLIGHT",
    ])
      expect(mineErrorText(c, "raw")).not.toBe("raw");
    expect(mineErrorText("OTHER", "raw")).toBe("raw");
  });
});
