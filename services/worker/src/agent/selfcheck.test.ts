import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SABOTAGED_FILES } from "./attempts.js";
import { DEFAULT_PACKAGE_DIR, localSelfCheck } from "./selfcheck.js";

const fixture = (name: string) => [
  {
    path: "csv2json.mjs",
    content: readFileSync(join(DEFAULT_PACKAGE_DIR, "fixtures", name, "csv2json.mjs"), "utf8"),
  },
];

describe("localSelfCheck (real verifier package, real runner)", () => {
  const check = localSelfCheck();
  it("PASS for the good fixture", async () => {
    expect((await check(fixture("good-delivery"))).outcome).toBe("PASS");
  });
  it("FAIL with a hint for the bad fixture and for the sabotaged file", async () => {
    for (const files of [fixture("bad-delivery"), SABOTAGED_FILES]) {
      const r = await check(files);
      expect(r.outcome).toBe("FAIL");
      expect(r.failedChecks).toEqual(["tests"]);
      expect(r.feedback).toContain("line break");
    }
  });
  it("feedback carries what the file did on the sample, including a crash", async () => {
    const crash = [{ path: "csv2json.mjs", content: "const a = 1;\na = 2;\n" }];
    const r = await check(crash);
    expect(r.outcome).toBe("FAIL");
    expect(r.feedback).toContain("crashed");
    expect(r.feedback).toContain("Assignment to constant");
    expect((await check(fixture("bad-delivery"))).feedback).toContain("printed");
  });
  it("WITHHOLD (never PASS) when the package cannot be found", async () => {
    const r = await localSelfCheck({ packageDir: "/nonexistent" })(fixture("good-delivery"));
    expect(r.outcome).toBe("WITHHOLD");
  });
});
