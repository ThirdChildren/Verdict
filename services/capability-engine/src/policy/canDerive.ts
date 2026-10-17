import {
  type ChildCapability,
  cmpAmount,
  formatAmount,
  parseAmount,
  payeesAttenuate,
  type RootCapability,
} from "@verdict/protocol";
import { ALLOW, block, type Decision, failClosed } from "./decision.js";

export interface DeriveContext {
  readonly now: Date;
  readonly precision: number;
  /** Signature checks are async and done at the edge; the result is passed in. */
  readonly parentSignatureValid: boolean;
  readonly parentRevoked: boolean;
  /** capabilityHash(parent), computed by the caller. */
  readonly parentHash: string;
  /** ledger.remaining(parent) in minor units. */
  readonly parentRemaining: bigint;
  /** Public ids of the preapproved workers (the root's "preapproved_workers" list). */
  readonly preapprovedWorkers: readonly string[];
}

/** ARCHITECTURE 8: pure, no AI. A child may only narrow its parent. Fails closed. */
export function canDerive(
  parent: RootCapability,
  child: ChildCapability,
  ctx: DeriveContext,
): Decision {
  return failClosed(() => {
    // 1. parent signature, revocation, expiry
    if (!ctx.parentSignatureValid) return block("SIGNATURE_INVALID", { subject: "the mandate" });
    if (ctx.parentRevoked) return block("CAPABILITY_REVOKED");
    if (Date.parse(parent.expires_at) <= ctx.now.getTime())
      return block("CAPABILITY_EXPIRED", { expires_at: parent.expires_at });
    if (Date.parse(child.expires_at) <= ctx.now.getTime())
      return block("CAPABILITY_EXPIRED", { expires_at: child.expires_at });
    // 2. link to the full signed parent
    if (child.parent !== ctx.parentHash) return block("PARENT_MISMATCH");
    // 8. same asset (checked early: amounts are meaningless across assets)
    if (child.asset_id !== parent.asset_id)
      return block("ASSET_MISMATCH", { actual: child.asset_id, expected: parent.asset_id });
    // 3. amounts
    const childMax = parseAmount(child.max_total, ctx.precision);
    const perTask = parseAmount(parent.max_per_task, ctx.precision);
    if (cmpAmount(childMax, perTask) > 0)
      return block("AMOUNT_EXCEEDS_PER_TASK", {
        amount: child.max_total,
        max: parent.max_per_task,
      });
    if (cmpAmount(childMax, ctx.parentRemaining) > 0)
      return block("AMOUNT_EXCEEDS_REMAINING", {
        amount: child.max_total,
        remaining: formatAmount(ctx.parentRemaining, ctx.precision),
      });
    // 4. expiry
    if (Date.parse(child.expires_at) > Date.parse(parent.expires_at))
      return block("CHILD_OUTLIVES_PARENT", {
        child_expires_at: child.expires_at,
        parent_expires_at: parent.expires_at,
      });
    // 5. actions and categories
    const badAction = child.allowed_actions.find((a) => !parent.allowed_actions.includes(a));
    if (badAction !== undefined)
      return block("ACTION_NOT_ALLOWED", {
        action: badAction,
        allowed: parent.allowed_actions.join(", "),
      });
    const badCat = child.allowed_categories.find((c) => !parent.allowed_categories.includes(c));
    if (badCat !== undefined)
      return block("CATEGORY_NOT_ALLOWED", {
        category: badCat,
        allowed: parent.allowed_categories.join(", "),
      });
    // 6. payees: the child list must be a subset of the parent's signed list
    const pay = payeesAttenuate(parent, child);
    if (!pay.ok) return block("PAYEE_NOT_IN_PARENT", { payee: pay.payee });
    // 6b. counterparties
    const badCp = child.counterparties.find((c) => !ctx.preapprovedWorkers.includes(c));
    if (badCp !== undefined) return block("COUNTERPARTY_NOT_ALLOWED", { counterparty: badCp });
    // 7. recurring can never be re-enabled
    if (parent.recurring === false && (child.recurring as boolean) !== false)
      return block("RECURRING_NOT_ALLOWED");
    return ALLOW;
  });
}
