import {
  type ChildCapability,
  cmpAmount,
  formatAmount,
  parseAmount,
  type RootCapability,
  type TaskContract,
} from "@verdict/protocol";
import type { DecodedInvoice } from "@verdict/wallet/types";
import { ALLOW, block, type Decision, failClosed } from "./decision.js";

/** Seconds per block used to convert min_final_cltv_expiry_delta into a lock window (invariant 4). */
export const SECONDS_PER_BLOCK = 600;

export interface PaymentCheckContext {
  readonly now: Date;
  readonly precision: number;
  readonly capSignatureValid: boolean;
  readonly contractSignaturesValid: boolean;
  readonly revoked: boolean;
  /** capabilityHash(cap), computed by the caller. */
  readonly capHash: string;
  /** Budget left for the cap and all ancestors, minor units. */
  readonly remaining: bigint;
  /** Non-released reservations already made on this cap. */
  readonly paymentsMade: number;
  readonly preapprovedWorkers: readonly string[];
  /** allowed_payees of every ancestor, root included. The worker must be on all of them. */
  readonly ancestorPayees: readonly (readonly string[])[];
}

export function lockWindowSeconds(
  invoice: Pick<DecodedInvoice, "min_final_cltv_expiry_delta">,
): number {
  return invoice.min_final_cltv_expiry_delta * SECONDS_PER_BLOCK;
}

/**
 * Everything authorizePayment checks before the reservation transaction. Pure.
 * Any exception becomes a BLOCK (fail closed).
 */
export function authorizePaymentChecks(
  cap: RootCapability | ChildCapability,
  invoice: DecodedInvoice,
  amount: bigint,
  contract: TaskContract,
  ctx: PaymentCheckContext,
): Decision {
  return failClosed(() => {
    if (!ctx.capSignatureValid)
      return block("SIGNATURE_INVALID", { subject: "the task permission" });
    if (!ctx.contractSignaturesValid)
      return block("SIGNATURE_INVALID", { subject: "the task contract" });
    if (ctx.revoked) return block("CAPABILITY_REVOKED");
    if (Date.parse(cap.expires_at) <= ctx.now.getTime())
      return block("CAPABILITY_EXPIRED", { expires_at: cap.expires_at });
    if (contract.capability_hash !== ctx.capHash) return block("PARENT_MISMATCH");
    if (cap.asset_id !== contract.payment.asset_id)
      return block("ASSET_MISMATCH", { actual: contract.payment.asset_id, expected: cap.asset_id });
    if (invoice.asset_id !== contract.payment.asset_id)
      return block("ASSET_MISMATCH", {
        actual: invoice.asset_id,
        expected: contract.payment.asset_id,
      });
    if (!cap.allowed_actions.includes("task_payment"))
      return block("ACTION_NOT_ALLOWED", {
        action: "task_payment",
        allowed: cap.allowed_actions.join(", "),
      });
    if (!cap.allowed_categories.includes(contract.task.category))
      return block("CATEGORY_NOT_ALLOWED", {
        category: contract.task.category,
        allowed: cap.allowed_categories.join(", "),
      });

    // 1. invoice hash
    if (invoice.payment_hash !== contract.payment.payment_hash)
      return block("INVOICE_HASH_MISMATCH");
    // 2. amount: contract == invoice == the amount being authorized
    const contractAmount = parseAmount(contract.payment.amount, ctx.precision);
    if (invoice.amount !== contractAmount || amount !== contractAmount)
      return block("INVOICE_AMOUNT_MISMATCH", {
        actual: formatAmount(invoice.amount, ctx.precision),
        expected: contract.payment.amount,
      });
    if ("max_per_task" in cap) {
      const perTask = parseAmount(cap.max_per_task, ctx.precision);
      if (cmpAmount(amount, perTask) > 0)
        return block("AMOUNT_EXCEEDS_PER_TASK", {
          amount: contract.payment.amount,
          max: cap.max_per_task,
        });
    }
    if (
      cmpAmount(amount, parseAmount(cap.max_total, ctx.precision)) > 0 ||
      cmpAmount(amount, ctx.remaining) > 0
    )
      return block("AMOUNT_EXCEEDS_REMAINING", {
        amount: contract.payment.amount,
        remaining: formatAmount(ctx.remaining < 0n ? 0n : ctx.remaining, ctx.precision),
      });
    if ("max_payments" in cap && ctx.paymentsMade >= cap.max_payments)
      return block("MAX_PAYMENTS_REACHED", { max: cap.max_payments });
    // 3. payee
    if (invoice.payee_node_id !== contract.payment.payee_node_id)
      return block("INVOICE_PAYEE_MISMATCH");
    const allowedCp =
      cap.counterparties === "preapproved_workers" ? ctx.preapprovedWorkers : cap.counterparties;
    if (!allowedCp.includes(contract.worker))
      return block("COUNTERPARTY_NOT_ALLOWED", { counterparty: contract.worker });
    if (
      !cap.allowed_payees.includes(contract.worker) ||
      ctx.ancestorPayees.some((l) => !l.includes(contract.worker))
    )
      return block("COUNTERPARTY_NOT_ALLOWED", { counterparty: contract.worker });
    // 4. HTLC lock window. The lock starts when the payment is sent (now), so the window must cover
    //    the time left until the deadline + verification + margin.
    const lock = lockWindowSeconds(invoice);
    const untilDeadline = Math.max(
      0,
      Math.ceil((Date.parse(contract.task.deadline) - ctx.now.getTime()) / 1000),
    );
    const required =
      untilDeadline + contract.task.max_verify_seconds + contract.safety_margin_seconds;
    if (!Number.isFinite(lock) || lock < required)
      return block("LOCK_WINDOW_TOO_SHORT", { actual: lock, required });
    if (lock > contract.max_lock_seconds)
      return block("LOCK_WINDOW_TOO_LONG", { actual: lock, max: contract.max_lock_seconds });
    return ALLOW;
  });
}
