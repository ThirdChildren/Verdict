import { type LlmClient, LlmError } from "@verdict/llm";
import type { SpendIntent } from "@verdict/protocol";
import type { WorkerDirectory } from "./identities.js";
import {
  amountsInText,
  CounterpartyError,
  llmIntentSchema,
  llmMandateSchema,
  type MandateProposal,
  resolveWorker,
  toMandateProposal,
  toSpendIntent,
} from "./llm-schemas.js";
import { INTENT_SYSTEM, MANDATE_SYSTEM } from "./prompts.js";

export class AgentError extends Error {
  constructor(
    readonly code: "PLAN_FAILED" | "AMOUNT_NOT_IN_GOAL" | "COUNTERPARTY_NOT_ALLOWED",
    message: string,
  ) {
    super(message);
    this.name = "AgentError";
  }
}

export type AgentConfig = { llm: LlmClient; workers: WorkerDirectory; now?: () => Date };

export class BuyerAgent {
  constructor(private readonly cfg: AgentConfig) {}
  private now() {
    return (this.cfg.now ?? (() => new Date()))();
  }

  async proposeMandate(goal: string): Promise<MandateProposal> {
    try {
      const { value } = await this.cfg.llm.structured(
        llmMandateSchema,
        [
          { role: "system", content: MANDATE_SYSTEM },
          { role: "user", content: `Goal: ${goal}` },
        ],
        { name: "mandate", maxTokens: 700 },
      );
      return toMandateProposal(
        value,
        this.now(),
        resolveWorker(value.worker, this.cfg.workers),
        goal,
        this.cfg.workers,
      );
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
    let intent: SpendIntent;
    let minor: number;
    try {
      const { value } = await this.cfg.llm.structured(
        llmIntentSchema,
        [
          { role: "system", content: INTENT_SYSTEM },
          { role: "user", content: `Goal: ${goal}` },
        ],
        { name: "spend_intent", maxTokens: 600 },
      );
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
    return intent;
  }

  private fail(err: unknown, message: string): AgentError {
    if (err instanceof CounterpartyError) return new AgentError(err.code, err.message);
    if (err instanceof LlmError) return new AgentError("PLAN_FAILED", message);
    throw err;
  }
}
