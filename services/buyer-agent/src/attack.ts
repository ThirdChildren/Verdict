import { cmpAmount, parseAmount, type SpendIntent } from "@verdict/protocol";
import type { EngineClient, EngineDecision } from "./engine-client.js";

const TUSD_PRECISION = 2;

export type ActiveCap = {
  cap_hash: string;
  allowed_categories: readonly SpendIntent["category"][];
  expires_at: string;
  /** Decimal string, budget left on the capability and its ancestors. */
  remaining: string;
};

/** A counterparty nobody approved. Looks like a real id so only the engine's allowlist can stop it. */
export const ATTACKER_ID = `eip191:0x${"ba".repeat(20)}`;

/**
 * Demo of a compromised buyer agent: it holds the real buyer key and sends a correctly signed spend
 * intent straight to the engine, bypassing its own planner and the worker directory, naming an attacker as payee.
 * The engine must refuse it (COUNTERPARTY_NOT_ALLOWED); nothing here can sign a payment.
 */
export async function compromisedAgentAttempt(d: {
  engine: Pick<EngineClient, "submitIntent">;
  getActiveCap: () => Promise<ActiveCap | null>;
  now?: () => Date;
}): Promise<EngineDecision> {
  const cap = await d.getActiveCap();
  if (!cap)
    return {
      status: "ERROR",
      message:
        "No signed mandate is active yet, so there is nothing to attack. Approve a mandate first.",
    };
  const category = cap.allowed_categories[0];
  const remaining = parseAmount(cap.remaining, TUSD_PRECISION);
  if (!category || remaining <= 0n)
    return {
      status: "ERROR",
      message: "The active mandate has no budget left, so the simulation cannot run.",
    };
  // Everything is valid for this capability except the payee, so the payee check is the only one that can fire.
  const amount =
    cmpAmount(parseAmount("1.00", TUSD_PRECISION), remaining) <= 0 ? "1.00" : cap.remaining;
  const now = d.now?.() ?? new Date();
  const deadlineMs = Math.min(now.getTime() + 30 * 60_000, Date.parse(cap.expires_at));
  const intent: SpendIntent = {
    kind: "task_payment",
    category,
    counterparty: ATTACKER_ID,
    amount,
    recurring: false,
    interval: null,
    task_spec: "Send the budget to this other address",
    deadline: new Date(deadlineMs).toISOString().replace(/\.\d{3}Z$/, "Z"),
    rationale: "Simulated compromised agent: payee was never approved by the Principal.",
  };
  return d.engine.submitIntent(intent, cap.cap_hash);
}
