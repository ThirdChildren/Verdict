import { join } from "node:path";
import { FakeLlm } from "@verdict/llm";
import { describe, expect, it } from "vitest";
import { llmGenerator, V1_SYSTEM } from "./generate.js";
import { loadPackageTask, packageId, readManifest } from "./package.js";

const ROOT = join(import.meta.dirname, "../../../../verifier-packages");
const CODE = "```js\nconsole.log('a long enough program for the extractor');\n```";

async function promptFor(pkg: string, spec: string) {
  const dir = join(ROOT, pkg);
  const llm = new FakeLlm([CODE]);
  const m = readManifest(dir);
  const info = { id: packageId(dir, m), description: m.description ?? "" };
  await llmGenerator(llm, 100, loadPackageTask(dir), info)(spec);
  return {
    sys: llm.calls[0]?.messages[0]?.content ?? "",
    user: llm.calls[0]?.messages[1]?.content ?? "",
    info,
  };
}

describe("the real packages drive the prompt", () => {
  it("json-normalise-v1: its description, not the CSV text", async () => {
    const { sys, info } = await promptFor("json-normalise-v1", "canonicalise a JSON file");
    expect(info.description.length).toBeGreaterThan(10);
    expect(sys).toContain(info.description);
    expect(sys).toContain("normalise.mjs");
    expect(sys).not.toContain(V1_SYSTEM);
    expect(sys).not.toContain("csv2json.mjs");
  });

  it("csv2json-v1: the v1 text plus the task header", async () => {
    const { sys, user } = await promptFor("csv2json-v1", "convert a CSV file to JSON");
    expect(sys).toContain(V1_SYSTEM);
    expect(sys.startsWith("The paid task is: convert a CSV file to JSON.")).toBe(true);
    expect(user).toBe("The paid task is: convert a CSV file to JSON");
  });
});
