import { cmpAmount, parseAmount, type SpendIntent, type TaskContract } from "@verdict/protocol";
import { ALLOW, block, type Decision, failClosed } from "./decision.js";

export interface AcceptedIntentFacts {
  /** hashObj({ cap_hash, intent }) under which the intent was accepted. */
  readonly intentSha256: string;
  readonly capHash: string;
  readonly intent: SpendIntent;
  /** Who signed the intent when it was accepted. */
  readonly signedBy: string;
}

export interface ContractLinkContext {
  readonly precision: number;
  /** The holder the ledger binds to the child capability. */
  readonly holder: string | undefined;
  /** The accepted intent stored under contract.intent_sha256, if any. */
  readonly accepted: AcceptedIntentFacts | undefined;
}

/**
 * A task contract may only fulfil a spend intent the engine accepted: same capability, signed by the holder of
 * that capability, the intended worker, and no more money than the intent asked for. Pure. Fails closed.
 */
export function checkContractLink(contract: TaskContract, ctx: ContractLinkContext): Decision {
  return failClosed(() => {
    const a = ctx.accepted;
    if (!a || a.intentSha256 !== contract.intent_sha256)
      return block("MALFORMED_INTENT", {
        reason: "the contract does not belong to any spend request the engine accepted",
      });
    if (a.capHash !== contract.capability_hash) return block("PARENT_MISMATCH");
    if (ctx.holder === undefined || a.signedBy !== ctx.holder)
      return block("SIGNATURE_INVALID", {
        subject: "the spend request (it was not signed by the holder of this task permission)",
      });
    if (contract.worker !== a.intent.counterparty)
      return block("COUNTERPARTY_NOT_ALLOWED", { counterparty: contract.worker });
    if (
      cmpAmount(
        parseAmount(contract.payment.amount, ctx.precision),
        parseAmount(a.intent.amount, ctx.precision),
      ) > 0
    )
      return block("MALFORMED_INTENT", {
        reason: `the contract asks for ${contract.payment.amount} tUSD but the approved request was only ${a.intent.amount} tUSD`,
      });
    if (contract.task.category !== a.intent.category)
      return block("CATEGORY_NOT_ALLOWED", {
        category: contract.task.category,
        allowed: a.intent.category,
      });
    if (Date.parse(contract.task.deadline) > Date.parse(a.intent.deadline))
      return block("MALFORMED_INTENT", {
        reason: "the contract deadline is later than the approved request allowed",
      });
    return ALLOW;
  });
}
