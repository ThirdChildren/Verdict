import { PAYMENT_STATUSES, TASK_STATES } from "@verdict/protocol";
import { describe, expect, it } from "vitest";
import { PAYMENT_CAPTIONS, TASK_CAPTIONS, VERDICT_CAPTIONS } from "./captions.js";

describe("captions", () => {
  it.each(TASK_STATES)("has a task caption for %s", (s) => {
    expect(TASK_CAPTIONS[s].length).toBeGreaterThan(10);
  });
  it.each(PAYMENT_STATUSES)("has a payment caption for %s", (s) => {
    expect(PAYMENT_CAPTIONS[s].length).toBeGreaterThan(10);
  });
  it.each(["RELEASE", "WITHHOLD"] as const)("has a verdict caption for %s", (v) => {
    expect(VERDICT_CAPTIONS[v].length).toBeGreaterThan(10);
  });
});
