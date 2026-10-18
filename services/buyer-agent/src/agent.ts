import { type LlmClient, LlmError, LlmTimeoutError } from "@verdict/llm";
import type { SpendIntent } from "@verdict/protocol";
import type { WorkerDirectory } from "./identities.js";
import {
  amountsInText,
  CounterpartyError,
  llmIntentSchema,
  llmMandateSchema,
  type MandateProposal,
  resolveWorker,
  routeSchema,
  toMandateProposal,
  toSpendIntent,
} from "./llm-schemas.js";
import {
  DEFAULT_TASK_TYPES,
  INTENT_SYSTEM,
  MANDATE_SYSTEM,
  type RouteTaskType,
  routeSystem,
} from "./prompts.js";

export class AgentError extends Error {
  constructor(
    readonly code:
      | "PLAN_FAILED"
      | "LLM_TIMEOUT"
      | "AMOUNT_NOT_IN_GOAL"
      | "COUNTERPARTY_NOT_ALLOWED"
      | "TASK_NOT_VERIFIABLE",
    message: string,
  ) {
    super(message);
    this.name = "AgentError";
  }
}

export type AgentConfig = {
  llm: LlmClient;
  workers: WorkerDirectory;
  now?: () => Date;
  /** Overrides both call sites (env BUYER_LLM_TIMEOUT_MS does the same). */
  timeoutMs?: number;
  /**
   * Catalogue of task types the engine can verify. When set, planIntent routes the request first and refuses
   * (TASK_NOT_VERIFIABLE) what no package fits. When absent no routing happens (unit tests of older paths).
   */
  taskTypes?: () => Promise<RouteTaskType[]>;
};

export const ROUTE_TIMEOUT_MS = 30_000;

export type Route = { package_id: string; reason: string };

/** Default per-call budgets in ms (the whole call including its one retry). */
export const MANDATE_TIMEOUT_MS = 60_000;
export const INTENT_TIMEOUT_MS = 45_000;

function timeoutFor(cfg: AgentConfig, dflt: number): number {
  if (cfg.timeoutMs !== undefined) return cfg.timeoutMs;
  const env = Number(process.env.BUYER_LLM_TIMEOUT_MS);
  return Number.isFinite(env) && env > 0 ? env : dflt;
}

export class BuyerAgent {
  constructor(private readonly cfg: AgentConfig) {}
  private now() {
    return (this.cfg.now ?? (() => new Date()))();
  }

  async proposeMandate(goal: string): Promise<MandateProposal> {
    return (await this.proposeMandateWithThinking(goal)).mandate;
  }

  async proposeMandateWithThinking(
    goal: string,
  ): Promise<{ mandate: MandateProposal; thinking: string }> {
    try {
      const { value, thinking } = await this.cfg.llm.structured(
        llmMandateSchema,
        [
          { role: "system", content: MANDATE_SYSTEM },
          { role: "user", content: `Goal: ${goal}` },
        ],
        { name: "mandate", maxTokens: 700, timeoutMs: timeoutFor(this.cfg, MANDATE_TIMEOUT_MS) },
      );
      const mandate = toMandateProposal(
        value,
        this.now(),
        resolveWorker(value.worker, this.cfg.workers),
        goal,
        this.cfg.workers,
      );
      return { mandate, thinking };
    } catch (err) {
      throw this.fail(err, "I could not turn that goal into a mandate. Please rephrase it.");
    }
  }

  /**
   * Plans one task. No policy here: an over-budget or recurring request is passed through untouched, the
   * engine blocks it. The one local check (ADR-019) is that the amount must appear in the user's text, which
   * catches model misreads (0.75 -> 7.50) without second-guessing what the user asked for.
   */
  async planIntent(goal: string): Promise<SpendIntent> {
    return (await this.planIntentWithThinking(goal)).intent;
  }

  /** Picks the one package that verifies this request, or throws TASK_NOT_VERIFIABLE. Nothing is sent either way. */
  async route(goal: string, types: RouteTaskType[]): Promise<Route> {
    let r: Route;
    try {
      const out = await this.cfg.llm.structured(
        routeSchema(types.map((t) => t.id)),
        [
          { role: "system", content: routeSystem(types) },
          { role: "user", content: `Request: ${goal}` },
        ],
        { name: "route", maxTokens: 300, timeoutMs: timeoutFor(this.cfg, ROUTE_TIMEOUT_MS) },
      );
      r = out.value;
    } catch (err) {
      throw this.fail(err, "I could not tell what kind of work this is. Nothing was sent.");
    }
    if (r.package_id === "none")
      throw new AgentError(
        "TASK_NOT_VERIFIABLE",
        `Verdict only buys work it can verify. Task types today: ${types.map((t) => t.title ?? t.id).join("; ")}. Nothing was sent.`,
      );
    return r;
  }

  async planIntentWithThinking(
    goal: string,
  ): Promise<{ intent: SpendIntent; thinking: string; route?: Route }> {
    let route: Route | undefined;
    if (this.cfg.taskTypes) {
      let types: RouteTaskType[];
      try {
        types = await this.cfg.taskTypes();
      } catch {
        throw new AgentError(
          "PLAN_FAILED",
          "The list of verifiable task types is not available, so nothing was sent.",
        );
      }
      route = await this.route(goal, types.length > 0 ? types : DEFAULT_TASK_TYPES);
    }
    let intent: SpendIntent;
    let minor: number;
    let thinking: string;
    try {
      const r = await this.cfg.llm.structured(
        llmIntentSchema,
        [
          { role: "system", content: INTENT_SYSTEM },
          { role: "user", content: `Goal: ${goal}` },
        ],
        {
          name: "spend_intent",
          maxTokens: 600,
          timeoutMs: timeoutFor(this.cfg, INTENT_TIMEOUT_MS),
        },
      );
      const value = r.value;
      thinking = r.thinking;
      minor = value.amount_minor;
      intent = toSpendIntent(value, resolveWorker(value.worker, this.cfg.workers), this.now());
    } catch (err) {
      throw this.fail(err, "I could not turn that goal into a payment request. Nothing was sent.");
    }
    if (!amountsInText(goal).has(BigInt(minor))) {
      throw new AgentError(
        "AMOUNT_NOT_IN_GOAL",
        `The planned amount ${intent.amount} tUSD does not appear in your request, so nothing was sent. Please state the amount clearly.`,
      );
    }
    return { intent, thinking, ...(route ? { route } : {}) };
  }

  private fail(err: unknown, message: string): AgentError {
    if (err instanceof CounterpartyError) return new AgentError(err.code, err.message);
    if (err instanceof LlmTimeoutError) return new AgentError("LLM_TIMEOUT", err.message);
    if (err instanceof LlmError) return new AgentError("PLAN_FAILED", message);
    throw err;
  }
}
