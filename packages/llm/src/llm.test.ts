import { afterEach, expect, test } from "vitest";
import { z } from "zod";
import { FakeLlm, LlmValidationError } from "./index.js";

const S = z.object({ n: z.number().int().min(1) }).strict();
const msgs = [{ role: "user" as const, content: "x" }];

afterEach(() => {
  delete process.env.VERDICT_MODE;
});

test("valid first try", async () => {
  const llm = new FakeLlm([{ n: 3 }]);
  const r = await llm.structured(S, msgs);
  expect(r.value).toEqual({ n: 3 });
  expect(r.attempts).toBe(1);
  expect(llm.calls[0]?.jsonSchema?.schema).toMatchObject({ additionalProperties: false });
});

test("schema-invalid output retries once with the error appended, then succeeds", async () => {
  const llm = new FakeLlm([{ n: 0 }, { n: 2 }]);
  const r = await llm.structured(S, msgs);
  expect(r.attempts).toBe(2);
  expect(llm.calls[1]?.messages.at(-1)?.content).toContain("Invalid");
});

test("two invalid outputs throw a typed error", async () => {
  const llm = new FakeLlm(["not json", { n: -1 }]);
  await expect(llm.structured(S, msgs)).rejects.toBeInstanceOf(LlmValidationError);
  expect(llm.calls).toHaveLength(2);
});

test("free mode extracts JSON from fenced text and sends no schema", async () => {
  const llm = new FakeLlm(['```json\n{"n": 5}\n```']);
  const r = await llm.structured(S, msgs, { mode: "free" });
  expect(r.value.n).toBe(5);
  expect(llm.calls[0]?.jsonSchema).toBeUndefined();
});

test("generateText streams tokens and reports stats", async () => {
  const llm = new FakeLlm(["hello world, streaming"]);
  const toks: string[] = [];
  const r = await llm.generateText(msgs, { onToken: (t) => toks.push(t) });
  expect(toks.join("")).toBe("hello world, streaming");
  expect(r.stats.tokensPerSec).toBe(100);
});

test("backend errors surface as LLM_CALL_FAILED", async () => {
  const llm = new FakeLlm([new Error("boom")]);
  await expect(llm.generateText(msgs)).rejects.toMatchObject({ code: "LLM_CALL_FAILED" });
});

test("FakeLlm refuses to exist in demo mode", () => {
  process.env.VERDICT_MODE = "demo";
  expect(() => new FakeLlm([])).toThrow(/demo/);
});
