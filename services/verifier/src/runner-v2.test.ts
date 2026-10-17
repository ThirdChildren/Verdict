import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  GENERIC_JUDGE_PATH,
  genericJudgeSha256,
  type ManifestV2,
  sha256OfFile,
} from "./manifest.js";
import { detectSandbox, runVerification } from "./runner.js";
import { makeDelivery, makeV2Package, SORT_SOURCE, type V2Options } from "./v2-fixture.js";

const root = mkdtempSync(join(tmpdir(), "runner-v2-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
afterEach(() => {
  delete process.env.VERIFIER_JUDGE_ALLOW;
});
const sandboxed = detectSandbox() !== null;
let n = 0;

const REAL_JUDGE = readFileSync(GENERIC_JUDGE_PATH, "utf8");
const sha = (text: string) =>
  sha256OfFile(join(makeV2Package(root, `hp${n++}`, { judgeSource: text }), "verify.mjs"));
const useProfile = (name: string) => (m: ManifestV2) => {
  m.profile = name;
};
const useJudge = (hash: string) => (m: ManifestV2) => {
  m.judge_sha256 = hash;
};

function run(opts: V2Options = {}, source?: string, seconds = 60) {
  const id = `r${n++}`;
  const packageDir = makeV2Package(root, `pkg-${id}`, opts);
  const deliveryDir = makeDelivery(root, `del-${id}`, source);
  return runVerification({ packageDir, deliveryDir, maxVerifySeconds: seconds });
}

/** A visible case prints "{}" so that only the advisory `visible` check fails. */
const BREAKS_VISIBLE = SORT_SOURCE.replace(
  "process.stdout.write(",
  'if (process.argv[2].includes("v__")) { process.stdout.write("{}"); process.exit(0); }\nprocess.stdout.write(',
);

describe.skipIf(!sandboxed)("runner, package format 2", () => {
  it("passes a good delivery and reports score, profile, weights and determinism", async () => {
    const r = await run();
    expect(r).toMatchObject({
      outcome: "PASS",
      exitCode: 0,
      score: 100,
      min_score: 80,
      profile: "standard",
      packageId: "sort-json-test",
      determinism: "match",
    });
    expect(r.checks.map((c) => c.id)).not.toContain("_verdict");
    expect(r.checks.find((c) => c.id === "fixtures")).toMatchObject({
      status: "pass",
      kind: "fixtures",
      weight: 50,
      required: true,
    });
  });

  it("runs the visible cases too (advisory fail costs score but not the verdict in standard)", async () => {
    const r = await run({}, BREAKS_VISIBLE);
    expect(r.outcome).toBe("PASS");
    expect(r.score).toBe(90);
    expect(r.checks.find((c) => c.id === "visible")).toMatchObject({
      status: "fail",
      required: false,
    });
  });

  it("FAILs on a required check even when the score is high", async () => {
    const r = await run({ schema: { type: "object", required: ["zzz"] } });
    expect(r).toMatchObject({
      outcome: "FAIL",
      exitCode: 1,
      score: 85,
      message: "A required check failed.",
    });
  });

  it("FAILs when the score is below min_score with every required check passing", async () => {
    const r = await run(
      {
        mutate: (m) => {
          const v = m.checks.find((c) => c.id === "visible");
          if (v) v.weight = 30;
        },
      },
      BREAKS_VISIBLE,
    );
    expect(r).toMatchObject({ outcome: "FAIL", score: 75, min_score: 80 });
    expect(r.checks.filter((c) => c.status === "fail" && c.required)).toHaveLength(0);
    expect(r.message).toContain("below the minimum");
  });

  it("strict profile promotes the advisory check", async () => {
    const r = await run({ mutate: useProfile("strict") }, BREAKS_VISIBLE);
    expect(r).toMatchObject({ outcome: "FAIL", profile: "strict" });
  });

  it("WITHHOLDs PACKAGE_INVALID when judge_sha256 does not match verify.mjs", async () => {
    const r = await run({ mutate: useJudge("a".repeat(64)) });
    expect(r).toMatchObject({ outcome: "WITHHOLD", code: "PACKAGE_INVALID" });
  });

  it("WITHHOLDs a foreign judge unless it is on VERIFIER_JUDGE_ALLOW", async () => {
    const foreign = `${REAL_JUDGE}\n// a different judge\n`;
    const h = sha(foreign);
    const opts = {
      judgeSource: foreign,
      mutate: useJudge(h),
    };
    expect(await run(opts)).toMatchObject({ outcome: "WITHHOLD", code: "PACKAGE_INVALID" });
    process.env.VERIFIER_JUDGE_ALLOW = `${h.slice(0, 8)},${h}`;
    expect(await run(opts)).toMatchObject({ outcome: "PASS", score: 100 });
    expect(genericJudgeSha256()).not.toBe(h);
  });

  it("WITHHOLDs VERIFY_OUTPUT_INVALID when the judge disagrees with the runner's recomputation", async () => {
    const lying = REAL_JUDGE.replace(
      "const pass = requiredOk && score >= minScore;",
      "const pass = true;",
    );
    expect(lying).not.toBe(REAL_JUDGE);
    const h = sha(lying);
    process.env.VERIFIER_JUDGE_ALLOW = h;
    const r = await run({
      judgeSource: lying,
      schema: { type: "object", required: ["zzz"] },
      mutate: useJudge(h),
    });
    expect(r).toMatchObject({ outcome: "WITHHOLD", code: "VERIFY_OUTPUT_INVALID" });
  });

  it("WITHHOLDs VERIFY_NONDETERMINISTIC when the judge's output changes between runs", async () => {
    const flaky = REAL_JUDGE.replace("ms: 0 }", "ms: Math.random() }");
    expect(flaky).not.toBe(REAL_JUDGE);
    const h = sha(flaky);
    process.env.VERIFIER_JUDGE_ALLOW = h;
    const r = await run({ judgeSource: flaky, mutate: useJudge(h) });
    expect(r).toMatchObject({
      outcome: "WITHHOLD",
      code: "VERIFY_NONDETERMINISTIC",
      determinism: "mismatch",
    });
  });

  it("full determinism re-runs the executor and catches a delivery that answers differently the second time", async () => {
    // Remembers, in the shared scratch dir, that it has already answered this input.
    const flakyDelivery = SORT_SOURCE.replace(
      "process.stdout.write(",
      `import { existsSync as ex, writeFileSync as wf } from "node:fs";
const mark = process.cwd() + "/scratch/" + process.argv[2].split("/").pop() + ".seen";
let again = false;
try { again = ex(mark); wf(mark, "1"); } catch {}
if (again) { process.stdout.write("{}"); process.exit(0); }
process.stdout.write(`,
    );
    // static check bans nothing relevant here; standard profile (judge-twice only) does not re-run the executor
    expect((await run({}, flakyDelivery)).outcome).toBe("PASS");
    const strict = await run({ mutate: useProfile("strict") }, flakyDelivery);
    expect(strict).toMatchObject({ outcome: "WITHHOLD", code: "VERIFY_NONDETERMINISTIC" });
  });
});
