import { FakeLlm } from "@verdict/llm";
import { describe, expect, it } from "vitest";
import { produceDelivery, TaskNotApplicableError } from "./attempts.js";
import {
  fullPrompt,
  llmGenerator,
  NotApplicableError,
  preamble,
  V1_INFO,
  V1_SYSTEM,
} from "./generate.js";
import type { PackageTask } from "./package.js";
import { hintFor } from "./selfcheck.js";

const task: PackageTask = {
  id: "json-normalise-v1",
  dir: "/x",
  description: "Print the canonical form of a JSON file.",
  entry: "normalise.mjs",
  inputExt: ".json",
  outputExt: ".out.json",
  visible: [],
  bannedImports: [],
  bannedTokens: [],
  limits: {},
  spec: [],
};
const START = (spec: string, id: string, d: string) =>
  `The paid task is: ${spec}. The test package is ${id}: ${d}. If the task is not what this package verifies, reply exactly NOT_APPLICABLE and nothing else.`;

describe("prompt per package", () => {
  it("V1_SYSTEM only for csv2json-v1, both prompts start with the preamble", () => {
    const v1 = fullPrompt("convert csv", V1_INFO);
    expect(v1.startsWith(START("convert csv", V1_INFO.id, V1_INFO.description))).toBe(true);
    expect(v1).toContain(V1_SYSTEM);
    const v2 = fullPrompt("normalise", { id: task.id, description: task.description }, task);
    expect(
      v2.startsWith(preamble("normalise", { id: task.id, description: task.description })),
    ).toBe(true);
    expect(v2).not.toContain("csv2json.mjs");
    expect(v2).toContain("normalise.mjs");
  });
});

describe("NOT_APPLICABLE", () => {
  it("the generator throws the typed refusal, not NoCodeError", async () => {
    const llm = new FakeLlm(["NOT_APPLICABLE"]);
    await expect(llmGenerator(llm, 100, task)("build a game")).rejects.toBeInstanceOf(
      NotApplicableError,
    );
  });

  it("produceDelivery delivers nothing and throws TaskNotApplicableError", async () => {
    const llm = new FakeLlm(["NOT_APPLICABLE.", "should never be asked"]);
    const p = produceDelivery({
      generator: llmGenerator(llm, 100, task),
      spec: "build a game",
      packageId: task.id,
      packageDescription: task.description,
    });
    const err = await p.catch((e) => e);
    expect(err).toBeInstanceOf(TaskNotApplicableError);
    expect(err.packageId).toBe("json-normalise-v1");
    expect(llm.calls).toHaveLength(1);
  });
});

describe("retry hints", () => {
  it("name the package and the task, never verify.sh", async () => {
    const llm = new FakeLlm(["```js\nconsole.log('a long enough program');\n```"]);
    await llmGenerator(
      llm,
      100,
      null,
    )("convert csv", {
      previousCode: "x",
      feedback: "- tests: failed.",
    });
    const retry = llm.calls[0]?.messages.at(-1)?.content ?? "";
    expect(
      retry.startsWith("This delivery is checked by csv2json-v1 against the task: convert csv."),
    ).toBe(true);
    expect(retry).not.toContain("verify.sh");
    expect(hintFor("csv2json-v1", "tests")).toContain("Quoting rule");
    expect(hintFor("json-normalise-v1", "fixtures")).toContain("sorted");
  });
});
