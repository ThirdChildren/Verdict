import { join } from "node:path";
import { FakeLlm } from "@verdict/llm";
import { describe, expect, test } from "vitest";
import { BuyerAgent } from "./agent.js";
import { AUTHOR_SYSTEM, authorSchema, NOT_VERIFIABLE_TEXT, REFRAME_CONTRACT } from "./author.js";
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
    const r = await post([d, d, d]);
    expect(r.statusCode).toBe(422);
    expect(r.json().code).toBe("AUTHOR_FAILED");
  });

  test("hygiene failure retries once with the complaint, then succeeds", async () => {
    const dup = draft({ hidden: [...pairs(4, "h"), { input: "v0 1", expected: "9" }] });
    const llm = new FakeLlm([dup, draft()]);
    const app = buildServer({ logger: false, llm, workers: {} });
    const r = await app.inject({
      method: "POST",
      url: "/api/author",
      payload: { request: "snake" },
    });
    await app.close();
    expect(r.statusCode).toBe(200);
    expect(llm.calls).toHaveLength(2);
    const last = JSON.stringify(llm.calls[1]?.messages);
    expect(last).toContain("Your previous draft was rejected: two test cases use the same input");
  });

  test("two hygiene retries still failing answer AUTHOR_FAILED naming the collision (three calls)", async () => {
    const dup = draft({ hidden: [...pairs(4, "h"), { input: "v0 1", expected: "9" }] });
    const llm = new FakeLlm([dup, dup, dup]);
    const app = buildServer({ logger: false, llm, workers: {} });
    const r = await app.inject({
      method: "POST",
      url: "/api/author",
      payload: { request: "snake" },
    });
    const ev = (await app.inject({ method: "GET", url: "/api/events" })).json().events;
    await app.close();
    expect(r.statusCode).toBe(422);
    expect(llm.calls).toHaveLength(3);
    expect(JSON.stringify(llm.calls[2]?.messages)).toContain('colliding inputs: \\"v0 1\\"');
    const res = ev.find((e: { type: string }) => e.type === "author.result");
    expect(res.data).toMatchObject({ feasibility: "failed", visible: 3, hidden: 4, attempts: 3 });
    expect(res.data.hygiene).toContain("v0 1");
  });

  test("duplicate inputs are dropped (first kept) and the draft accepted when enough remain", async () => {
    const d = draft({
      hidden: [...pairs(8, "h")],
      visible: [...pairs(2, "v"), { input: "v0 1", expected: "9" }],
    });
    const b = (await post([d])).json();
    expect(b.draft.visible).toHaveLength(3);
    expect(b.draft.hidden).toHaveLength(7);
    expect(b.draft.visible.map((p: { input: string }) => p.input)).toEqual([
      "v0 1",
      "v1 2",
      "h0 1",
    ]);
  });

  test("too few after cleanup retries with the named collisions, then accepts", async () => {
    const dup = draft({ hidden: [...pairs(4, "h"), { input: "v0 1", expected: "9" }] });
    const llm = new FakeLlm([dup, draft()]);
    const app = buildServer({ logger: false, llm, workers: {} });
    const r = await app.inject({
      method: "POST",
      url: "/api/author",
      payload: { request: "snake" },
    });
    await app.close();
    expect(r.statusCode).toBe(200);
    expect(JSON.stringify(llm.calls[1]?.messages)).toContain("colliding inputs");
  });

  test("author.result carries request, feasibility, reason and counts, no case contents", async () => {
    const app = buildServer({ logger: false, llm: new FakeLlm([snake]), workers: {} });
    await app.inject({ method: "POST", url: "/api/author", payload: { request: "x".repeat(200) } });
    const ev = (await app.inject({ method: "GET", url: "/api/events" })).json().events;
    await app.close();
    const res = ev.find((e: { type: string }) => e.type === "author.result").data;
    expect(res).toEqual({
      request: "x".repeat(120),
      feasibility: "reframe",
      reason: "Fixed input and output.",
      visible: 3,
      hidden: 5,
      attempts: 1,
    });
  });

  test("two hygiene failures answer AUTHOR_FAILED with the plain message", async () => {
    const dup = draft({ hidden: [...pairs(4, "h"), { input: "v0 1", expected: "9" }] });
    const r = await post([dup, dup, dup]);
    expect(r.statusCode).toBe(422);
    expect(r.json().code).toBe("AUTHOR_FAILED");
    expect(r.json().message).toContain("two test cases use the same input");
  });

  test("one timeout bounds both author calls", async () => {
    const dup = draft({ hidden: [...pairs(4, "h"), { input: "v0 1", expected: "9" }] });
    const t0 = Date.now();
    const r = await post([dup, draft()], "sum two numbers", { delayMs: 40, llmTimeoutMs: 60 });
    expect(r.statusCode).toBe(422);
    expect(r.json().message).toContain("took too long");
    expect(Date.now() - t0).toBeLessThan(300);
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
  test("26 cases, 8 cli, 10 reframe, 8 none", () => {
    expect(cases).toHaveLength(26);
    for (const [l, n] of [
      ["cli", 8],
      ["reframe", 10],
      ["none", 8],
    ] as const)
      expect(cases.filter((c) => c.label === l)).toHaveLength(n);
  });
  test("scripted replies reproduce each label through the HTTP outcome", async () => {
    const replies = cases.map((c) =>
      c.label === "cli" ? draft() : c.label === "reframe" ? snake : none,
    );
    const r = await runAuthorEval(
      new BuyerAgent({ llm: new FakeLlm(replies), workers: {} }),
      cases,
    );
    expect([r.correct, r.noneAccepted]).toEqual([26, 0]);
  });
  test("a model that drafts everything counts 8 none accepted", async () => {
    const r = await runAuthorEval(
      new BuyerAgent({ llm: new FakeLlm(cases.map(() => draft())), workers: {} }),
      cases,
    );
    expect([r.correct, r.noneAccepted]).toEqual([8, 8]);
  });
  test("the reframe prompt fixes the state/move contract and the eight snake scenarios", () => {
    expect(AUTHOR_SYSTEM).toContain(REFRAME_CONTRACT);
    for (const k of [
      '"state"',
      '"move"',
      "argv[2]",
      '"grid":[w,h]',
      '"snake":[[x,y]',
      '"dir":"R"',
      "U, D, L, R",
    ])
      expect(AUTHOR_SYSTEM).toContain(k);
    for (const k of [
      "normal move",
      "a turn",
      "eat food and grow",
      "wall collision",
      "self collision",
      "opposite direction is ignored",
      "after death",
      "two-step",
    ])
      expect(AUTHOR_SYSTEM).toContain(k);
    expect(AUTHOR_SYSTEM).toContain("eight distinct scenarios");
  });
  test("per-case HTTP outcome matches the label", async () => {
    for (const c of cases) {
      const reply = c.label === "cli" ? draft() : c.label === "reframe" ? snake : none;
      const r = await post([reply], c.request);
      expect(r.statusCode).toBe(c.label === "none" ? 422 : 200);
    }
  });
});
