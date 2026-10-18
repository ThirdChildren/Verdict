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
import { DEFAULT_TASK_TYPES, type RouteTaskType } from "./prompts.js";

export const SERVICE = "buyer-agent";

export type AgentEvent = { seq: number; at: string; type: string; data: unknown };

export type ServerDeps = {
  logger?: boolean;
  llm?: LlmClient;
  engine?: EngineClient;
  /** Worker names the agent may hire, mapped to public ids (from identities.json). */
  workers?: WorkerDirectory;
  /** Hash of the child capability the engine bound to this buyer; null until one is registered. */
  /** Catalogue source for routing (main.ts passes engine.fetchTaskTypes). Absent: no routing. */
  taskTypes?: () => Promise<{ id: string; description: string; title?: string }[]>;
  getCapHash?: () => Promise<string | null>;
  getActiveCap?: () => Promise<ActiveCap | null>;
  now?: () => Date;
  /** Per-call LLM budget override in ms (default: per call site, or env BUYER_LLM_TIMEOUT_MS). */
  llmTimeoutMs?: number;
  /** Host/peer/Origin guard. main.ts always passes it. */
  localOnly?: LocalOnlyOptions;
};

const failMessage = (err: unknown) => (err instanceof AgentError ? err.message : String(err));

const goalBody = z
  .object({ goal: z.string().min(3).max(1000), package_id: z.string().min(1).max(100).optional() })
  .strict();

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
          ...(deps.taskTypes ? { taskTypes: deps.taskTypes } : {}),
          ...(deps.llmTimeoutMs !== undefined ? { timeoutMs: deps.llmTimeoutMs } : {}),
        })
      : null;

  const guard = (reply: { code(n: number): unknown }, err: unknown) => {
    if (err instanceof AgentError) {
      reply.code(
        err.code === "AMOUNT_NOT_IN_GOAL" ||
          err.code === "TASK_NOT_VERIFIABLE" ||
          err.code === "AUTHOR_FAILED"
          ? 422
          : err.code === "COUNTERPARTY_NOT_ALLOWED"
            ? 403
            : err.code === "CATALOGUE_UNAVAILABLE"
              ? 503
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

  // Routing only: which verifiable task type fits this request, or 422 TASK_NOT_VERIFIABLE. Sends nothing.
  app.post("/api/route", async (req, reply) => {
    const body = z
      .object({ request: z.string().min(3).max(1000) })
      .strict()
      .safeParse(req.body);
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
    const request = body.data.request;
    let types: RouteTaskType[];
    try {
      types = deps.taskTypes ? await deps.taskTypes() : DEFAULT_TASK_TYPES;
    } catch (err) {
      app.log.warn({ err: failMessage(err) }, "route: catalogue unavailable");
      return reply.code(503).send({
        ok: false,
        code: "CATALOGUE_UNAVAILABLE",
        message: "The list of verifiable task types is not available right now. Nothing was sent.",
      });
    }
    try {
      const r = await agent.route(request, types.length > 0 ? types : DEFAULT_TASK_TYPES);
      app.log.info(
        { request: request.slice(0, 120), package_id: r.package_id, reason: r.reason },
        "route decision",
      );
      return { ok: true, package_id: r.package_id, reason: r.reason };
    } catch (err) {
      if (err instanceof AgentError && err.code === "TASK_NOT_VERIFIABLE") {
        app.log.info(
          { request: request.slice(0, 120), package_id: "none", reason: err.reason },
          "route decision",
        );
        reply.code(422);
        return {
          ok: false,
          code: err.code,
          message: err.message,
          package_id: "none",
          reason: err.reason ?? "",
          task_types: types.map((t) => ({ id: t.id, title: t.title ?? t.id })),
        };
      }
      return guard(reply, err);
    }
  });

  // E33: draft an acceptance test for a request. The model only proposes; the engine validates and installs.
  app.post("/api/author", async (req, reply) => {
    const body = z
      .object({ request: z.string().min(3).max(1000) })
      .strict()
      .safeParse(req.body);
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
      const r = await agent.author(body.data.request);
      emit("author.drafted", { feasibility: r.feasibility, title: r.draft.title });
      return { ok: true, ...r };
    } catch (err) {
      emit("author.failed", { message: failMessage(err) });
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
      const { intent, thinking, route } = await agent.planIntentWithThinking(
        body.data.goal,
        body.data.package_id,
      );
      if (body.data.package_id)
        app.log.info(
          { package_id: body.data.package_id },
          "routing skipped: package bound by the engine",
        );
      // Intent fields stay at the top level (older readers); `intent` and `thinking` sit beside them.
      emit("intent.proposed", {
        ...intent,
        intent,
        thinking,
        ...(route ? { package_id: route.package_id, route_reason: route.reason } : {}),
      });
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
      return { ok: true, intent, decision, ...(route ? { package_id: route.package_id } : {}) };
    } catch (err) {
      emit("intent.failed", {
        message: failMessage(err),
        ...(err instanceof AgentError ? { code: err.code } : {}),
      });
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
