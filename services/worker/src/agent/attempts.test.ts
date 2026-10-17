import { describe, expect, it } from "vitest";
import { MAX_ATTEMPTS, produceDelivery, SABOTAGED_FILES } from "./attempts.js";
import { type Generated, type Generator, NoCodeError } from "./generate.js";
import type { CheckFn, SelfCheck } from "./selfcheck.js";
import { classifyTps } from "./speed.js";

const gen = (n: number): Generated => ({
  files: [{ path: "csv2json.mjs", content: `// v${n}\n` }],
  model: "fake",
  generationMs: 1000,
  generatedTokens: 100,
  tokensPerSec: 100,
});
const fail: SelfCheck = { outcome: "FAIL", failedChecks: ["tests"], feedback: "- tests: failed." };
const pass: SelfCheck = { outcome: "PASS", failedChecks: [], feedback: "" };

function harness(results: SelfCheck[]) {
  let calls = 0;
  const feedbacks: (string | undefined)[] = [];
  const generator: Generator = async (_s, retry) => {
    feedbacks.push(retry?.feedback);
    return gen(++calls);
  };
  let i = 0;
  const check: CheckFn = async () => results[Math.min(i++, results.length - 1)] as SelfCheck;
  return { generator, check, feedbacks, calls: () => calls };
}

describe("produceDelivery", () => {
  it("stops at the first PASS", async () => {
    const h = harness([pass]);
    const r = await produceDelivery({ generator: h.generator, check: h.check, spec: "x" });
    expect(r.attempts).toHaveLength(1);
    expect(r.best.check?.outcome).toBe("PASS");
  });

  it("retries with the failing output as feedback and delivers the passing attempt", async () => {
    const h = harness([fail, pass]);
    const progress: number[] = [];
    const r = await produceDelivery({
      generator: h.generator,
      check: h.check,
      spec: "x",
      onProgress: (p) => progress.push(p.attempt),
    });
    expect(h.feedbacks).toEqual([undefined, "- tests: failed."]);
    expect(progress).toEqual([1, 2]);
    expect(r.best.n).toBe(2);
  });

  it("makes at most 3 attempts, then delivers anyway", async () => {
    const h = harness([fail]);
    const r = await produceDelivery({ generator: h.generator, check: h.check, spec: "x" });
    expect(h.calls()).toBe(MAX_ATTEMPTS);
    expect(r.best.check?.outcome).toBe("FAIL");
  });

  it("does not retry when the local check could not run", async () => {
    const h = harness([{ outcome: "WITHHOLD", failedChecks: [], feedback: "no sandbox" }]);
    const r = await produceDelivery({ generator: h.generator, check: h.check, spec: "x" });
    expect(r.attempts).toHaveLength(1);
  });

  it("keeps the earlier attempt when a retry generation throws", async () => {
    let n = 0;
    const generator: Generator = async () => {
      if (++n > 1) throw new Error("boom");
      return gen(1);
    };
    const r = await produceDelivery({ generator, check: async () => fail, spec: "x" });
    expect(r.best.n).toBe(1);
  });

  it("treats a model that wrote no code as a failed attempt and asks again", async () => {
    let n = 0;
    const seen: (string | undefined)[] = [];
    const generator: Generator = async (_s, retry) => {
      seen.push(retry?.feedback);
      if (++n === 1) throw new NoCodeError();
      return gen(n);
    };
    const r = await produceDelivery({ generator, check: async () => pass, spec: "x" });
    expect(r.best.n).toBe(2);
    expect(seen[1]).toContain("no file");
  });

  it("gives up with the error when every attempt wrote no code", async () => {
    const generator: Generator = async () => {
      throw new NoCodeError();
    };
    await expect(produceDelivery({ generator, spec: "x" })).rejects.toThrow("no code");
  });

  it("a failing first generation is an error, not a delivery", async () => {
    const generator: Generator = async () => {
      throw new Error("no model");
    };
    await expect(produceDelivery({ generator, spec: "x" })).rejects.toThrow("no model");
  });

  it("sabotaged: broken file, no model call, no self-check", async () => {
    const h = harness([pass]);
    const r = await produceDelivery({
      generator: h.generator,
      check: h.check,
      spec: "x",
      sabotaged: true,
    });
    expect(h.calls()).toBe(0);
    expect(r.best.generated.files).toEqual(SABOTAGED_FILES);
    expect(r.best.generated.model).toContain("sabotaged");
    expect(r.best.check).toBeNull();
  });
});

describe("classifyTps", () => {
  it("ok from 30, warn 15 to 30, fail below 15 or unknown", () => {
    expect(classifyTps(64)).toBe("ok");
    expect(classifyTps(30)).toBe("ok");
    expect(classifyTps(29.9)).toBe("warn");
    expect(classifyTps(15)).toBe("warn");
    expect(classifyTps(14.9)).toBe("fail");
    expect(classifyTps(null)).toBe("fail");
  });
});

describe("deadline handling (E22)", () => {
  const slow: Generator = (_s, _r, _h, limits) =>
    new Promise((_, reject) => {
      limits?.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });

  it("deadline reached during attempt 2 delivers the best of attempt 1", async () => {
    let calls = 0;
    const generator: Generator = (s, r, h, l) =>
      ++calls === 1 ? Promise.resolve(gen(1)) : slow(s, r, h, l);
    const t0 = Date.now();
    const r = await produceDelivery({
      generator,
      check: async () => fail,
      spec: "x",
      deadlineMs: t0 + 400,
      maxVerifySeconds: 0,
      safetySeconds: 0.2,
    });
    expect(r.best.n).toBe(1);
    expect(r.best.check?.outcome).toBe("FAIL");
    expect(r.attempts.map((a) => a.reason)).toEqual(["done", "timeout"]);
    expect(calls).toBe(2);
    expect(Date.now() - t0).toBeLessThan(1500);
  });

  it("nothing usable before the deadline is a failure, not a hang", async () => {
    const t0 = Date.now();
    await expect(
      produceDelivery({
        generator: slow,
        spec: "x",
        deadlineMs: t0 + 150,
        maxVerifySeconds: 0,
        safetySeconds: 0,
      }),
    ).rejects.toThrow(/ran out of time/);
    expect(Date.now() - t0).toBeLessThan(1500);
  });

  it("attempts carry timestamps and reasons; an external abort is reason aborted", async () => {
    const ok = await produceDelivery({
      generator: harness([pass]).generator,
      check: async () => pass,
      spec: "x",
    });
    const a = ok.attempts[0];
    expect(a?.reason).toBe("done");
    expect(Date.parse(a?.started_at ?? "")).toBeLessThanOrEqual(Date.parse(a?.ended_at ?? ""));
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 30);
    await expect(
      produceDelivery({ generator: slow, spec: "x", signal: ac.signal }),
    ).rejects.toThrow(/stopped/);
  });

  it("a missing sandbox is a failed attempt and nothing is delivered", async () => {
    const { localSelfCheck } = await import("./selfcheck.js");
    const check = localSelfCheck({ detect: () => null });
    const r = await check([{ path: "csv2json.mjs", content: "x" }]);
    expect(r.outcome).toBe("FAIL");
    expect(r.feedback).toMatch(/no sandbox/);
    const h = harness([]);
    await expect(produceDelivery({ generator: h.generator, check, spec: "x" })).rejects.toThrow(
      /no sandbox/,
    );
    expect(h.calls()).toBe(1);
  });
});
