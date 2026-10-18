import { join } from "node:path";
import { FakeLlm } from "@verdict/llm";
import { describe, expect, test } from "vitest";
import { BuyerAgent } from "./agent.js";
import { loadCases, runRouteEval } from "./route-eval.js";

const TYPES = [
  { id: "csv2json-v1", description: "Convert a CSV file to a JSON array of objects." },
  { id: "json-normalise-v1", description: "Print the canonical form of a JSON file." },
];
const cases = loadCases(join(import.meta.dirname, "../eval/route-cases.json"));

describe("route-eval plumbing", () => {
  test("the set has 8 + 8 + 8 labelled cases", () => {
    const n = (l: string) => cases.filter((c) => c.label === l).length;
    expect([cases.length, n("csv2json-v1"), n("json-normalise-v1"), n("none")]).toEqual([
      24, 8, 8, 8,
    ]);
  });

  test("a model that answers every label is 24/24 with no false accepts", async () => {
    const llm = new FakeLlm(cases.map((c) => ({ package_id: c.label, reason: "ok" })));
    const r = await runRouteEval(new BuyerAgent({ llm, workers: {} }), cases, TYPES);
    expect([r.correct, r.falseAccepts, r.wrongPackage, r.falseRejects]).toEqual([24, 0, 0, 0]);
  });

  test("a model that accepts everything as csv2json-v1 is counted as 8 right, 8 wrong package, 8 false accepts", async () => {
    const llm = new FakeLlm(cases.map(() => ({ package_id: "csv2json-v1", reason: "x" })));
    const r = await runRouteEval(new BuyerAgent({ llm, workers: {} }), cases, TYPES);
    expect([r.correct, r.wrongPackage, r.falseAccepts]).toEqual([8, 8, 8]);
  });

  test("a model that abstains on everything has 8 false rejects per package and 0 false accepts", async () => {
    const llm = new FakeLlm(cases.map(() => ({ package_id: "none", reason: "x" })));
    const r = await runRouteEval(new BuyerAgent({ llm, workers: {} }), cases, TYPES);
    expect([r.correct, r.falseRejects, r.falseAccepts]).toEqual([8, 16, 0]);
  });
});

describe("route-cases.json shape", () => {
  test("24 entries, 8 per label, each with a non-empty request and a known label", () => {
    const labels = ["csv2json-v1", "json-normalise-v1", "none"];
    expect(cases).toHaveLength(24);
    for (const l of labels) expect(cases.filter((c) => c.label === l)).toHaveLength(8);
    for (const c of cases) {
      expect(c.request.trim().length).toBeGreaterThan(0);
      expect(labels).toContain(c.label);
    }
  });

  test("the FakeLlm plumbing routes every case to its own label", async () => {
    const llm = new FakeLlm(cases.map((c) => ({ package_id: c.label, reason: "ok" })));
    const r = await runRouteEval(new BuyerAgent({ llm, workers: {} }), cases, TYPES);
    expect(r.rows.every((x) => x.got === x.label)).toBe(true);
  });
});
