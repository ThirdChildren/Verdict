import { FakeLlm } from "@verdict/llm";
import { createEd25519Signer } from "@verdict/protocol";
import { describe, expect, test, vi } from "vitest";
import { AgentError, BuyerAgent } from "./agent.js";
import { EngineClient } from "./engine-client.js";
import { routeSchema } from "./llm-schemas.js";
import { DEFAULT_TASK_TYPES } from "./prompts.js";
import { buildServer } from "./server.js";

const WORKERS = { worker: `eip191:0x${"b".repeat(40)}` };
const TYPES = [
  { id: "csv2json-v1", description: "Convert CSV to JSON." },
  { id: "json-normalise-v1", description: "Canonical JSON." },
];
const now = () => new Date("2026-10-18T15:00:00Z");
const intent = {
  kind: "task_payment",
  worker: "worker",
  category: "code",
  amount_minor: 120,
  recurring: false,
  interval: "none",
  task_spec: "Normalise JSON",
  deadline_minutes: 60,
  rationale: "One-off task.",
};
const mk = (replies: object[]) => {
  const llm = new FakeLlm(replies);
  return {
    llm,
    agent: new BuyerAgent({ llm, workers: WORKERS, now, taskTypes: async () => TYPES }),
  };
};

describe("routing", () => {
  test("the schema enum is the catalogue plus none", () => {
    const s = routeSchema(["a", "b"]);
    expect(s.safeParse({ package_id: "none", reason: "r" }).success).toBe(true);
    expect(s.safeParse({ package_id: "a", reason: "r" }).success).toBe(true);
    expect(s.safeParse({ package_id: "c", reason: "r" }).success).toBe(false);
  });

  test("the prompt lists the catalogue, allows none and has negative examples", async () => {
    const { llm, agent } = mk([{ package_id: "json-normalise-v1", reason: "fits" }, intent]);
    await agent.planIntent("Normalise my JSON for 1.20 tUSD");
    const sys = llm.calls[0]?.messages[0]?.content ?? "";
    expect(sys).toContain("json-normalise-v1: Canonical JSON.");
    expect(sys).toContain("none");
    expect(sys).toContain("JSON file to CSV");
    expect(sys).toContain("snake game");
    expect(JSON.stringify(llm.calls[0])).toContain("none");
  });

  test("an exact fit continues to the intent and carries the package id", async () => {
    const { agent } = mk([{ package_id: "json-normalise-v1", reason: "fits" }, intent]);
    const r = await agent.planIntentWithThinking("Normalise my JSON for 1.20 tUSD");
    expect(r.route?.package_id).toBe("json-normalise-v1");
    expect(r.intent.amount).toBe("1.20");
  });

  test("none refuses with TASK_NOT_VERIFIABLE, lists the types and makes no intent call", async () => {
    const { llm, agent } = mk([{ package_id: "none", reason: "game" }]);
    const err = await agent.planIntent("Build a snake game for 1.20 tUSD").catch((e) => e);
    expect(err).toBeInstanceOf(AgentError);
    expect(err.code).toBe("TASK_NOT_VERIFIABLE");
    expect(err.message).toContain("Verdict only buys work it can verify. Task types today:");
    expect(err.message).toContain("csv2json-v1");
    expect(err.message).toContain("Nothing was sent.");
    expect(llm.calls).toHaveLength(1);
  });

  test("the server sends nothing to the engine on abstain and passes package_id otherwise", async () => {
    const signer = await createEd25519Signer(new Uint8Array(32).fill(7));
    const fetchFn = vi.fn(async () => new Response("{}", { status: 500 }));
    const engine = new EngineClient({
      baseUrl: "http://e",
      engineId: `eip191:0x${"e".repeat(40)}`,
      signer,
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    const app = buildServer({
      logger: false,
      llm: new FakeLlm([{ package_id: "none", reason: "x" }]),
      workers: WORKERS,
      engine,
      taskTypes: async () => TYPES,
      getCapHash: async () => "c".repeat(64),
      now,
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/plan",
      payload: { goal: "Build a snake game for 1.20 tUSD" },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe("TASK_NOT_VERIFIABLE");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  test("the engine client sends an unchanged intent body and treats a 404 catalogue as csv2json-v1 only", async () => {
    const signer = await createEd25519Signer(new Uint8Array(32).fill(7));
    const bodies: unknown[] = [];
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith("/api/task-types")) return new Response("no", { status: 404 });
      bodies.push(JSON.parse(String(init?.body)));
      return new Response("{}", { status: 500 });
    });
    const engine = new EngineClient({
      baseUrl: "http://e",
      engineId: `eip191:0x${"e".repeat(40)}`,
      signer,
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(await engine.fetchTaskTypes()).toEqual(DEFAULT_TASK_TYPES);
    await engine.submitIntent(
      {
        kind: "task_payment",
        category: "code",
        counterparty: `eip191:0x${"b".repeat(40)}`,
        amount: "1.20",
        recurring: false,
        interval: null,
        task_spec: "x",
        deadline: "2026-10-18T16:00:00Z",
        rationale: "r",
      },
      "c".repeat(64),
    );
    expect(Object.keys((bodies[0] as { body: object }).body).sort()).toEqual([
      "cap_hash",
      "intent",
    ]);
  });

  test("POST /api/route answers 200 with the package and 422 with the ids on none", async () => {
    const mkApp = (r: object) =>
      buildServer({
        logger: false,
        llm: new FakeLlm([r]),
        workers: WORKERS,
        taskTypes: async () => TYPES,
        now,
      });
    const ok = await mkApp({ package_id: "csv2json-v1", reason: "fits" }).inject({
      method: "POST",
      url: "/api/route",
      payload: { request: "Convert CSV to JSON" },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ ok: true, package_id: "csv2json-v1", reason: "fits" });
    const no = await mkApp({ package_id: "none", reason: "x" }).inject({
      method: "POST",
      url: "/api/route",
      payload: { request: "Build a snake game" },
    });
    expect(no.statusCode).toBe(422);
    expect(no.json()).toMatchObject({
      ok: false,
      code: "TASK_NOT_VERIFIABLE",
      task_types: ["csv2json-v1", "json-normalise-v1"],
    });
  });
});
