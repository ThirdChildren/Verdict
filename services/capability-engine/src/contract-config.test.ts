import { describe, expect, it } from "vitest";
import { contractLimits } from "./contract-config.js";

describe("contractLimits", () => {
  it("defaults max_lock_seconds to 28800 (above the 25200 s regtest lock)", () => {
    expect(contractLimits({}).max_lock_seconds).toBe(28_800);
  });
  it("reads overrides and rejects junk", () => {
    expect(contractLimits({ MAX_LOCK_SECONDS: "3600" }).max_lock_seconds).toBe(3600);
    expect(() => contractLimits({ MAX_LOCK_SECONDS: "-1" })).toThrow(/MAX_LOCK_SECONDS/);
  });
});
