import { describe, expect, it } from "vitest";
import { railRows, stepViews } from "../lib/view.js";
import { initialState, reduce } from "../store.js";
import { SCENES } from "./storyboard.js";

const run = (id: string) => {
  const s = SCENES.find((x) => x.id === id);
  if (!s) throw new Error(id);
  return s.events.reduce(reduce, initialState);
};

describe("mock storyboard", () => {
  it("covers every stage state", () => {
    expect(SCENES.map((s) => s.id)).toEqual([
      "empty",
      "authorized",
      "working",
      "verify-fail",
      "verify-pass",
      "settled",
      "fail-refunded",
      "refunded",
      "expired",
      "ring",
      "blocked",
      "second-mandate",
      "mandates-history",
      "refused",
    ]);
  });
  it("each scene reduces to the intended chip and step", () => {
    expect(run("empty").root).toBeNull();
    expect(railRows(run("authorized"))[0]?.chip).toBe("Working");
    expect(railRows(run("working"))[0]?.chip).toBe("Locked");
    expect(railRows(run("verify-fail"))[0]?.chip).toBe("Refund pending");
    expect(railRows(run("settled"))[0]?.chip).toBe("Paid");
    expect(railRows(run("refunded"))[0]?.chip).toBe("Refunded");
    expect(railRows(run("fail-refunded"))[0]?.chip).toBe("Refunded");
    expect(railRows(run("expired"))[0]?.chip).toBe("Expired");
    expect(railRows(run("blocked"))[0]?.chip).toBe("Blocked");
    const t = Object.values(run("refunded").tasks)[0];
    expect(t && stepViews(t, { engine: "E", worker: "W", verifier: "V" })[4]?.label).toBe(
      "Refunded",
    );
  });
});
