import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirHashFromDisk } from "@verdict/protocol/node";
import { afterAll, describe, expect, it } from "vitest";
import { detectSandbox, runVerification } from "./runner.js";

const PKG = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../verifier-packages/json-normalise-v1",
);
const GOOD = join(PKG, "fixtures/good-delivery");
const BAD = join(PKG, "fixtures/bad-delivery");
const root = mkdtempSync(join(tmpdir(), "json-normalise-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const run = (deliveryDir: string, packageDir = PKG) =>
  runVerification({ packageDir, deliveryDir, maxVerifySeconds: 60 });

describe.skipIf(detectSandbox() === null)("json-normalise-v1", { timeout: 60_000 }, () => {
  it("passes the good delivery with score 100 under standard", async () => {
    const r = await run(GOOD);
    expect(r).toMatchObject({
      outcome: "PASS",
      score: 100,
      min_score: 80,
      profile: "standard",
      packageId: "json-normalise-v1",
    });
    expect(r.checks.every((c) => c.status === "pass")).toBe(true);
  });

  it("fails the bad delivery on fixtures only, below min score", async () => {
    const r = await run(BAD);
    expect(r.outcome).toBe("FAIL");
    expect(r.checks.filter((c) => c.status === "fail").map((c) => c.id)).toEqual(["fixtures"]);
    expect(r.score).toBe(50);
    expect(r.score).toBeLessThan(r.min_score as number);
  });

  it("gives identical check lines when the same delivery is judged twice", async () => {
    const lines = (r: Awaited<ReturnType<typeof run>>) =>
      JSON.stringify(
        r.checks.map(({ id, status, kind, weight, required }) => [
          id,
          status,
          kind,
          weight,
          required,
        ]),
      );
    const a = await run(GOOD);
    const b = await run(GOOD);
    expect(lines(a)).toBe(lines(b));
    expect(a.score).toBe(b.score);
  });

  it("has a stable directory hash", async () => {
    const h1 = await dirHashFromDisk(PKG);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    expect(await dirHashFromDisk(PKG)).toBe(h1);
    console.log(`json-normalise-v1 package sha256: ${h1}`);
  });

  it("still passes the good delivery under the strict profile", async () => {
    const copy = join(root, "strict-pkg");
    cpSync(PKG, copy, { recursive: true });
    const mp = join(copy, "manifest.json");
    const m = JSON.parse(readFileSync(mp, "utf8"));
    m.profile = "strict";
    writeFileSync(mp, JSON.stringify(m, null, 2));
    const r = await run(GOOD, copy);
    expect(r).toMatchObject({
      outcome: "PASS",
      score: 100,
      profile: "strict",
      determinism: "match",
    });
  });
});
