import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeLlm } from "@verdict/llm";
import { dirHashFromDisk } from "@verdict/protocol/node";
import { afterAll, describe, expect, it } from "vitest";
import { llmGenerator, systemPrompt, V1_SYSTEM } from "./generate.js";
import { buildPackagePrompt, loadPackageTask, packageMap, resolvePackageDir } from "./package.js";
import { FALLBACK_HINT, hintFor, localSelfCheck } from "./selfcheck.js";

const FIX = join(import.meta.dirname, "__fixtures__", "pkg-json-norm-v2");
const tmp = mkdtempSync(join(tmpdir(), "pkgtest-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("v1 prompt", () => {
  it("is unchanged without a package task", () => {
    expect(systemPrompt()).toBe(V1_SYSTEM);
    expect(createHash("sha256").update(V1_SYSTEM).digest("hex")).toBe(
      "098fbdef3e0e87815beb025b1a9a731deb667c84072445e72fcee229f7b49a07",
    );
  });
});

describe("v2 prompt", () => {
  const task = loadPackageTask(FIX);
  it("is built from the manifest and visible cases only", () => {
    if (!task) throw new Error("no task");
    const p = buildPackagePrompt(task);
    expect(p).toContain("sort object keys alphabetically");
    expect(p).toContain("normalise.mjs");
    expect(p).toContain(".json");
    expect(p).toContain('{ "b": 1, "a": 2 }');
    expect(p).toContain('"y": 1');
    expect(p).toContain("net, http, child_process");
    expect(p).toContain("at most 300 lines");
    expect(p).toContain("must contain the keys: a");
    expect(p).toContain("one fenced code block");
    expect(p).not.toContain("HIDDEN_SECRET");
    expect(p).not.toContain("csv2json");
  });
  it("the generator names the file after the manifest entry", async () => {
    const llm = new FakeLlm(["```js\nconsole.log('x'.repeat(30));\n```"]);
    const g = llmGenerator(llm as never, 100, task);
    const r = await g("spec");
    expect(r.files[0]?.path).toBe("normalise.mjs");
  });
  it("v1 manifest gives no task", () => {
    expect(
      loadPackageTask(join(import.meta.dirname, "../../../../verifier-packages/csv2json-v1")),
    ).toBeNull();
  });
});

describe("package resolution by hash", () => {
  it("picks the right dir, skips _judge, reports a missing hash", async () => {
    const root = join(tmp, "root");
    mkdirSync(join(root, "_judge"), { recursive: true });
    writeFileSync(join(root, "_judge", "verify.mjs"), "x");
    cpSync(FIX, join(root, "a"), { recursive: true });
    cpSync(FIX, join(root, "b"), { recursive: true });
    writeFileSync(join(root, "b", "extra.txt"), "different");
    const hb = await dirHashFromDisk(join(root, "b"));
    expect(await resolvePackageDir(hb, root)).toBe(join(root, "b"));
    expect(await resolvePackageDir(await dirHashFromDisk(join(root, "a")), root)).toBe(
      join(root, "a"),
    );
    expect(await resolvePackageDir("0".repeat(64), root)).toBeNull();
    expect((await packageMap(root)).size).toBe(2);
    const r = await localSelfCheck({ packageSha256: "0".repeat(64), packagesRoot: root })([]);
    expect(r.outcome).toBe("WITHHOLD");
    expect(r.feedback).toContain("package not available locally");
  });
});

describe("hints", () => {
  it("specific, generic by kind, then fallback", () => {
    expect(hintFor("csv2json-v1", "tests")).toContain("line break");
    expect(hintFor("other-v1", "x", "fixtures")).toContain("expected output");
    expect(hintFor("other-v1", "weird")).toBe(FALLBACK_HINT);
  });
});
