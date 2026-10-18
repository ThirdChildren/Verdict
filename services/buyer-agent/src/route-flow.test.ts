import { FakeLlm } from "@verdict/llm";
import { createEd25519Signer } from "@verdict/protocol";
import { describe, expect, test, vi } from "vitest";
import { EngineClient } from "./engine-client.js";
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

async function mk(replies: object[]) {
  const signer = await createEd25519Signer(new Uint8Array(32).fill(7));
  const bodies: unknown[] = [];
  const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response("{}", { status: 500 });
  });
  const engine = new EngineClient({
    baseUrl: "http://e",
    engineId: `eip191:0x${"e".repeat(40)}`,
    signer,
    fetchFn: fetchFn as unknown as typeof fetch,
  });
  const submit = vi.spyOn(engine, "submitIntent");
  const app = buildServer({
    logger: false,
    llm: new FakeLlm(replies),
    workers: WORKERS,
    engine,
    taskTypes: async () => TYPES,
    getCapHash: async () => "c".repeat(64),
    now,
  });
  return { app, fetchFn, submit, bodies };
}

describe("buyer routing flow with a FakeLlm", () => {
  test("/api/route answers 422 on none and makes no engine call", async () => {
    const s = await mk([{ package_id: "none", reason: "game" }]);
    const res = await s.app.inject({
      method: "POST",
      url: "/api/route",
      payload: { request: "develop a simple snake game" },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ ok: false, code: "TASK_NOT_VERIFIABLE" });
    expect(s.submit).not.toHaveBeenCalled();
    expect(s.fetchFn).not.toHaveBeenCalled();
  });

  test("a json-normalise route emits intent.proposed with package_id; the SPEND_INTENT body has only cap_hash and intent", async () => {
    const s = await mk([{ package_id: "json-normalise-v1", reason: "fits" }, intent]);
    const res = await s.app.inject({
      method: "POST",
      url: "/api/plan",
      payload: { goal: "Normalise my JSON for 1.20 tUSD" },
    });
    expect(res.json()).toMatchObject({ package_id: "json-normalise-v1" });
    const ev = (await s.app.inject({ method: "GET", url: "/api/events" })).json() as {
      events: { type: string; data: Record<string, unknown> }[];
    };
    const proposed = ev.events.find((e) => e.type === "intent.proposed");
    expect(proposed?.data.package_id).toBe("json-normalise-v1");
    expect(s.submit).toHaveBeenCalledTimes(1);
    const env = s.bodies[0] as { type: string; body: object };
    expect(env.type).toBe("SPEND_INTENT");
    expect(Object.keys(env.body).sort()).toEqual(["cap_hash", "intent"]);
  });
});
