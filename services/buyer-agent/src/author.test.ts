import { join } from "node:path";
import { FakeLlm } from "@verdict/llm";
import { describe, expect, test } from "vitest";
import { BuyerAgent } from "./agent.js";
import { authorSchema, NOT_VERIFIABLE_TEXT } from "./author.js";
import { loadAuthorCases, runAuthorEval } from "./author-eval.js";
import { buildServer } from "./server.js";

const pairs = (n: number, p = "") =>
  Array.from({ length: n }, (_, i) => ({
    input: `${p}${i} ${i + 1}`,
    expected: `${p}${2 * i + 1}`,
  }));
const draft = (over: Record<string, unknown> = {}) => ({
  reason: "Fixed input and output.",
  feasibility: "cli",
  title: "Add two numbers",
  description: "Read argv[2], print the sum.",
  entry: "add-two.mjs",
  input_ext: ".txt",
  visible: pairs(3, "v"),
  hidden: pairs(5, "h"),
  assertions: {},
  ...over,
});
const none = { reason: "An essay has no fixed answer.", feasibility: "none" };
const snake = draft({
  feasibility: "reframe",
  reframe:
    "Verdict can verify a program that reads an input and prints an output. For a snake game it can verify the game logic.",
  entry: "snake.mjs",
  input_ext: ".json",
});

async function post(
  replies: Array<object | string | Error>,
  request = "sum two numbers",
  opts = {},
) {
  const app = buildServer({
    logger: false,
    llm: new FakeLlm(replies, opts),
    workers: {},
    ...("llmTimeoutMs" in opts ? { llmTimeoutMs: opts.llmTimeoutMs as number } : {}),
  });
  const res = await app.inject({ method: "POST", url: "/api/author", payload: { request } });
  await app.close();
  return res;
}

describe("authorSchema", () => {
  test("accepts cli, reframe and none", () => {
    expect(authorSchema.safeParse(draft()).success).toBe(true);
    expect(authorSchema.safeParse(snake).success).toBe(true);
    expect(authorSchema.safeParse(none).success).toBe(true);
  });
  test.each([
    ["2 visible", draft({ visible: pairs(2) })],
    ["4 hidden", draft({ hidden: pairs(4) })],
    ["9 hidden", draft({ hidden: pairs(9) })],
    ["bad entry", draft({ entry: "Add.mjs" })],
    ["bad ext", draft({ input_ext: ".exe" })],
    ["unknown assertion", draft({ assertions: { sneaky: true } })],
    ["long title", draft({ title: "x".repeat(61) })],
    ["long input", draft({ visible: [{ input: "x".repeat(2049), expected: "1" }, ...pairs(2)] })],
    ["missing hidden", draft({ hidden: undefined })],
    ["reframe without text", draft({ feasibility: "reframe" })],
    ["extra key", draft({ extra: 1 })],
  ])("refuses %s", (_n, d) => {
    expect(authorSchema.safeParse(d).success).toBe(false);
  });
});

describe("POST /api/author", () => {
  test("author returns a draft only for a feasible request", async () => {
    const r = await post([draft()]);
    expect(r.statusCode).toBe(200);
    const b = r.json();
    expect(b).toMatchObject({ ok: true, feasibility: "cli" });
    expect(Object.keys(b.draft).sort()).toEqual(
      ["assertions", "description", "entry", "hidden", "input_ext", "title", "visible"].sort(),
    );
    expect(b.draft.hidden).toHaveLength(5);
    const n = await post([none]);
    expect(n.statusCode).toBe(422);
    expect(n.json()).toMatchObject({ code: "TASK_NOT_VERIFIABLE", message: NOT_VERIFIABLE_TEXT });
    expect(n.json().draft).toBeUndefined();
    const z = await post(["not json", "still not json"]);
    expect(z.statusCode).toBe(422);
    expect(z.json()).toMatchObject({ ok: false, code: "AUTHOR_FAILED" });
    expect(z.json().draft).toBeUndefined();
  });

  test("reframes a game into its engine", async () => {
    const r = await post([snake], "write a snake game");
    expect(r.statusCode).toBe(200);
    const b = r.json();
    expect(b.feasibility).toBe("reframe");
    expect(b.reframe).toContain("snake game");
    expect(b.draft.entry).toBe("snake.mjs");
    expect(b.draft.input_ext).toBe(".json");
  });

  test("schema-invalid reply retries once, then AUTHOR_FAILED", async () => {
    const r = await post([draft({ hidden: pairs(2) }), draft({ hidden: pairs(2) })]);
    expect(r.statusCode).toBe(422);
    expect(r.json().code).toBe("AUTHOR_FAILED");
    const ok = await post([draft({ hidden: pairs(2) }), draft()]);
    expect(ok.statusCode).toBe(200);
  });

  test("timeout is 422 AUTHOR_FAILED with a plain message", async () => {
    const r = await post([draft()], "sum", { delayMs: 400, llmTimeoutMs: 30 });
    expect(r.statusCode).toBe(422);
    expect(r.json()).toMatchObject({ code: "AUTHOR_FAILED" });
    expect(r.json().message).toContain("took too long");
  });

  test.each([
    ["duplicate inputs", draft({ hidden: [...pairs(4, "h"), { input: "v0 1", expected: "9" }] })],
    [
      "all-equal outputs",
      draft({
        visible: pairs(3).map((p) => ({ ...p, expected: "1" })),
        hidden: pairs(5, "h").map((p) => ({ ...p, expected: " 1 " })),
      }),
    ],
    ["empty expected", draft({ hidden: [...pairs(4, "h"), { input: "z", expected: "  " }] })],
    ["empty input", draft({ hidden: [...pairs(4, "h"), { input: "", expected: "5" }] })],
    ["fenced empty", draft({ hidden: [...pairs(4, "h"), { input: "z", expected: "```\n```" }] })],
  ])("hygiene refuses %s", async (_n, d) => {
    const r = await post([d]);
    expect(r.statusCode).toBe(422);
    expect(r.json().code).toBe("AUTHOR_FAILED");
  });

  test("strips code fences from cases", async () => {
    const d = draft({
      hidden: [...pairs(4, "h"), { input: "```\n4 5\n```", expected: "```text\n9\n```" }],
    });
    const b = (await post([d])).json();
    expect(b.draft.hidden[4]).toEqual({ input: "4 5", expected: "9" });
  });

  test("bad body is 400", async () => {
    const app = buildServer({ logger: false, llm: new FakeLlm([]), workers: {} });
    const r = await app.inject({ method: "POST", url: "/api/author", payload: { request: "x" } });
    expect(r.statusCode).toBe(400);
  });
});

describe("author-eval plumbing", () => {
  const cases = loadAuthorCases(join(import.meta.dirname, "../eval/author-cases.json"));
  test("24 cases, 8 per label", () => {
    expect(cases).toHaveLength(24);
    for (const l of ["cli", "reframe", "none"])
      expect(cases.filter((c) => c.label === l)).toHaveLength(8);
  });
  test("scripted replies reproduce each label through the HTTP outcome", async () => {
    const replies = cases.map((c) =>
      c.label === "cli" ? draft() : c.label === "reframe" ? snake : none,
    );
    const r = await runAuthorEval(
      new BuyerAgent({ llm: new FakeLlm(replies), workers: {} }),
      cases,
    );
    expect([r.correct, r.noneAccepted]).toEqual([24, 0]);
  });
  test("a model that drafts everything counts 8 none accepted", async () => {
    const r = await runAuthorEval(
      new BuyerAgent({ llm: new FakeLlm(cases.map(() => draft())), workers: {} }),
      cases,
    );
    expect([r.correct, r.noneAccepted]).toEqual([8, 8]);
  });
  test("per-case HTTP outcome matches the label", async () => {
    for (const c of cases) {
      const reply = c.label === "cli" ? draft() : c.label === "reframe" ? snake : none;
      const r = await post([reply], c.request);
      expect(r.statusCode).toBe(c.label === "none" ? 422 : 200);
    }
  });
});
