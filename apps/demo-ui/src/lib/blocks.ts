import type { BlockCode } from "@verdict/protocol";

/** Short plain-language title per catalogue code. Record<BlockCode,...> keeps this exhaustive at compile time. */
export const BLOCK_TITLES: Record<BlockCode, string> = {
  MALFORMED_INTENT: "Request not understood",
  AMOUNT_EXCEEDS_PER_TASK: "Over the per-task limit",
  AMOUNT_EXCEEDS_REMAINING: "Not enough budget left",
  RECURRING_NOT_ALLOWED: "Recurring payment not allowed",
  CATEGORY_NOT_ALLOWED: "Spending category not allowed",
  ACTION_NOT_ALLOWED: "Action not allowed",
  COUNTERPARTY_NOT_ALLOWED: "Recipient not approved",
  PAYEE_NOT_IN_PARENT: "Payee not covered by the mandate",
  CAPABILITY_EXPIRED: "Permission expired",
  CAPABILITY_REVOKED: "Permission revoked",
  MAX_PAYMENTS_REACHED: "Payment count used up",
  PARENT_MISMATCH: "Permission does not match its mandate",
  CHILD_OUTLIVES_PARENT: "Permission would outlast its mandate",
  SIGNATURE_INVALID: "Signature could not be verified",
  ASSET_MISMATCH: "Wrong asset",
  INVOICE_HASH_MISMATCH: "Invoice locked to the wrong secret",
  INVOICE_AMOUNT_MISMATCH: "Invoice amount differs from contract",
  INVOICE_PAYEE_MISMATCH: "Invoice pays the wrong recipient",
  LOCK_WINDOW_TOO_SHORT: "Funds would unlock too early",
  LOCK_WINDOW_TOO_LONG: "Funds would stay locked too long",
  PACKAGE_HASH_MISMATCH: "Verifier package differs from contract",
  PREIMAGE_MISMATCH: "Secret does not match the payment lock",
  DELIVERY_HASH_MISMATCH: "Delivered files altered",
  DELIVERY_REJECTED: "Delivery failed verification",
  VERIFIER_TIMEOUT: "Verifier took too long",
  DEADLINE_PASSED: "Deadline passed",
};

/** Codes raised after a task is already running: money may be locked, but none is released. */
const POST_ESCROW: ReadonlySet<BlockCode> = new Set([
  "DELIVERY_HASH_MISMATCH",
  "DELIVERY_REJECTED",
  "VERIFIER_TIMEOUT",
  "DEADLINE_PASSED",
]);

export function blockReassurance(code: BlockCode): string {
  return POST_ESCROW.has(code)
    ? "No payment was released. Locked funds return to you if the worker does not pass in time."
    : "Nothing was signed. No funds moved.";
}
