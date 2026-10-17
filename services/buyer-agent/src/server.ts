import {
  demoTogglesEnabled,
  type LocalOnlyOptions,
  localOnly,
  loggerOptions,
} from "@verdict/http-local";
import type { LlmClient } from "@verdict/llm";
import { hashObj } from "@verdict/protocol";
import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import { AgentError, BuyerAgent } from "./agent.js";
import { type ActiveCap, compromisedAgentAttempt } from "./attack.js";
import type { EngineClient } from "./engine-client.js";
import type { WorkerDirectory } from "./identities.js";

export const SERVICE = "buyer-agent";

export type AgentEvent = { seq: number; at: string; type: string; data: unknown };

export type ServerDeps = {
  logger?: boolean;
  llm?: LlmClient;
  engine?: EngineClient;
  /** Worker names the agent may hire, mapped to public ids (from identities.json). */
  workers?: WorkerDirectory;
  /** Hash of the child capability the engine bound to this buyer; null until one is registered. */
  getCapHash?: () => Promise<string | null>;
  getActiveCap?: () => Promise<ActiveCap | null>;
  now?: () => Date;
  /** Per-call LLM budget override in ms (default: per call site, or env BUYER_LLM_TIMEOUT_MS). */
  llmTimeoutMs?: number;
  /** Host/peer/Origin guard. main.ts always passes it. */
  localOnly?: LocalOnlyOptions;
};

const failMessage = (err: unknown) => (err instanceof AgentError ? err.message : String(err));

const goalBody = z.object({ goal: z.string().min(3).max(1000) }).strict();

export function buildServer(deps: ServerDeps = {}): FastifyInstance {
  const app = Fastify({ logger: deps.logger === false ? false : loggerOptions(SERVICE) });
  if (deps.localOnly) localOnly(app, deps.localOnly);
  const events: AgentEvent[] = [];
  const emit = (type: string, data: unknown) => {
    const e = { seq: events.length + 1, at: new Date().toISOString(), type, data };
    events.push(e);
    if (events.length > 200) events.shift();
    return e;
  };

  app.get("/health", async () => ({
    ok: true,
    service: SERVICE,
    model_ready: deps.llm !== undefined,
  }));
  app.get("/api/events", async () => ({ events }));

  const agent =
    deps.llm && deps.workers
      ? new BuyerAgent({
          llm: deps.llm,
          workers: deps.workers,
          ...(deps.now ? { now: deps.now } : {}),
          ...(deps.llmTimeoutMs !== undefined ? { timeoutMs: deps.llmTimeoutMs } : {}),
        })
      : null;

  const guard = (reply: { code(n: number): unknown }, err: unknown) => {
    if (err instanceof AgentError) {
      reply.code(
        err.code === "AMOUNT_NOT_IN_GOAL"
          ? 422
          : err.code === "COUNTERPARTY_NOT_ALLOWED"
            ? 403
            : err.code === "LLM_TIMEOUT"
              ? 504
              : 502,
      );
      return { ok: false, code: err.code, message: err.message };
    }
    throw err;
  };

  // 1. Mandate proposal (before the Principal signs).
  app.post("/api/goal", async (req, reply) => {
    const body = goalBody.safeParse(req.body);
    if (!body.success)
      return reply.code(400).send({
        ok: false,
        code: "BAD_REQUEST",
        message: "Please describe your goal in a sentence.",
      });
    if (!agent)
      return reply
        .code(503)
        .send({ ok: false, code: "NOT_READY", message: "The local model is not loaded yet." });
    try {
      const { mandate, thinking } = await agent.proposeMandateWithThinking(body.data.goal);
      // Mandate fields stay at the top level (older readers); goal and thinking sit beside them.
      emit("mandate.proposed", { ...mandate, goal: body.data.goal, thinking });
      return { ok: true, mandate };
    } catch (err) {
      emit("mandate.failed", { message: failMessage(err) });
      return guard(reply, err);
    }
  });

  // 2. After the mandate is signed: plan the task and POST the spend intent. The engine's answer
  // (including BLOCKED) is surfaced as an event and in the response; the agent works the same either way.
  app.post("/api/plan", async (req, reply) => {
    const body = goalBody.safeParse(req.body);
    if (!body.success)
      return reply.code(400).send({
        ok: false,
        code: "BAD_REQUEST",
        message: "Please describe the task in a sentence.",
      });
    if (!agent)
      return reply
        .code(503)
        .send({ ok: false, code: "NOT_READY", message: "The local model is not loaded yet." });
    try {
      const { intent, thinking } = await agent.planIntentWithThinking(body.data.goal);
      // Intent fields stay at the top level (older readers); `intent` and `thinking` sit beside them.
      emit("intent.proposed", { ...intent, intent, thinking });
      const capHash = (await deps.getCapHash?.()) ?? null;
      if (!capHash)
        return reply.code(409).send({
          ok: false,
          code: "NO_CAPABILITY",
          message: "No signed mandate is active yet, so nothing was sent.",
        });
      if (!deps.engine)
        return reply.code(500).send({
          ok: false,
          code: "MISCONFIGURED",
          message: "The engine client is not configured. Nothing was sent.",
        });
      const decision = await deps.engine.submitIntent(intent, capHash);
      emit("intent.engine_decision", {
        intent,
        decision,
        // Same form the engine stores: hash of the cap hash plus the intent.
        intent_sha256: hashObj({ cap_hash: capHash, intent }),
        cap_hash: capHash,
      });
      return { ok: true, intent, decision };
    } catch (err) {
      emit("intent.failed", { message: failMessage(err) });
      return guard(reply, err);
    }
  });

  // Demo only: a "compromised" buyer signs a spend intent to an unapproved payee. The engine must refuse it.
  app.post("/api/attack/compromised-agent", async (_req, reply) => {
    if (!demoTogglesEnabled()) return reply.callNotFound();
    if (!deps.engine || !deps.getActiveCap)
      return reply.code(503).send({
        ok: false,
        code: "NOT_READY",
        message: "The engine connection is not configured, so the simulation cannot run.",
      });
    const decision = await compromisedAgentAttempt({
      engine: deps.engine,
      getActiveCap: deps.getActiveCap,
      ...(deps.now ? { now: deps.now } : {}),
    });
    emit("attack.compromised_agent", decision);
    return { ok: true, decision };
  });

  return app;
}
