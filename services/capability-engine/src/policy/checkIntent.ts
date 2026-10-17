import {
  type ChildCapability,
  cmpAmount,
  formatAmount,
  parseAmount,
  type RootCapability,
  type SpendIntent,
} from "@verdict/protocol";
import { ALLOW, block, type Decision, failClosed, withDetail } from "./decision.js";

export interface IntentContext {
  readonly now: Date;
  readonly precision: number;
  readonly revoked: boolean;
  /** Budget left for this capability AND its ancestors (the minimum along the chain), minor units. */
  readonly remaining: bigint;
  /** Reservations that are not released for this capability. */
  readonly paymentsMade: number;
  readonly preapprovedWorkers: readonly string[];
  /** allowed_payees of every ancestor, root included (signed lists). The payee must be on all of them. */
  readonly ancestorPayees: readonly (readonly string[])[];
}

/** Validates a (Zod-parsed) spend intent against the capability. Pure. Fails closed. */
export function checkIntent(
  cap: RootCapability | ChildCapability,
  intent: SpendIntent,
  ctx: IntentContext,
): Decision {
  return failClosed(() => {
    if (ctx.revoked) return block("CAPABILITY_REVOKED");
    if (Date.parse(cap.expires_at) <= ctx.now.getTime())
      return block("CAPABILITY_EXPIRED", { expires_at: cap.expires_at });
    if (!cap.allowed_actions.includes(intent.kind))
      return block("ACTION_NOT_ALLOWED", {
        action: intent.kind,
        allowed: cap.allowed_actions.join(", "),
      });
    if (!cap.allowed_categories.includes(intent.category))
      return block("CATEGORY_NOT_ALLOWED", {
        category: intent.category,
        allowed: cap.allowed_categories.join(", "),
      });
    if (intent.recurring || intent.interval !== null) return block("RECURRING_NOT_ALLOWED");
    const allowedCp =
      cap.counterparties === "preapproved_workers" ? ctx.preapprovedWorkers : cap.counterparties;
    if (!allowedCp.includes(intent.counterparty))
      return block("COUNTERPARTY_NOT_ALLOWED", { counterparty: intent.counterparty });
    if (
      !cap.allowed_payees.includes(intent.counterparty) ||
      ctx.ancestorPayees.some((l) => !l.includes(intent.counterparty))
    )
      return block("COUNTERPARTY_NOT_ALLOWED", { counterparty: intent.counterparty });
    if (Date.parse(intent.deadline) <= ctx.now.getTime())
      return block("DEADLINE_PASSED", { deadline: intent.deadline });
    if (Date.parse(intent.deadline) > Date.parse(cap.expires_at))
      // Not expired yet: the task would end after the permission does. Say so, keep the catalogue code.
      return withDetail(
        block("CAPABILITY_EXPIRED", { expires_at: cap.expires_at }),
        `(The permission has not expired yet, but it ends before this task's deadline, ${intent.deadline}. Use a longer mandate or a shorter deadline.)`,
      );
    const amount = parseAmount(intent.amount, ctx.precision);
    if ("max_per_task" in cap) {
      const perTask = parseAmount(cap.max_per_task, ctx.precision);
      if (cmpAmount(amount, perTask) > 0)
        return block("AMOUNT_EXCEEDS_PER_TASK", { amount: intent.amount, max: cap.max_per_task });
    }
    if (cmpAmount(amount, parseAmount(cap.max_total, ctx.precision)) > 0)
      return block("AMOUNT_EXCEEDS_REMAINING", {
        amount: intent.amount,
        remaining: formatAmount(ctx.remaining < 0n ? 0n : ctx.remaining, ctx.precision),
      });
    if (cmpAmount(amount, ctx.remaining) > 0)
      return block("AMOUNT_EXCEEDS_REMAINING", {
        amount: intent.amount,
        remaining: formatAmount(ctx.remaining < 0n ? 0n : ctx.remaining, ctx.precision),
      });
    if ("max_payments" in cap && ctx.paymentsMade >= cap.max_payments)
      return block("MAX_PAYMENTS_REACHED", { max: cap.max_payments });
    return ALLOW;
  });
}
