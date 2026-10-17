import { z } from "zod";
import { hashUnsigned } from "./canonical.js";
import {
  assetId,
  category,
  hex32,
  isoUtc,
  lnNodeId,
  paymentHash,
  positiveAmountString,
  publicId,
  signatureString,
  taskIdSchema,
} from "./primitives.js";

export const TASK_VERSION = "verdict-task/0";

const contractBase = {
  version: z.literal(TASK_VERSION),
  buyer: publicId,
  worker: publicId,
  capability_hash: hex32,
  payment: z
    .object({
      asset_id: assetId,
      amount: positiveAmountString,
      payment_hash: paymentHash,
      payee_node_id: lnNodeId,
      expiry_blocks: z.number().int().positive(),
      expiry_seconds: z.number().int().positive(),
    })
    .strict(),
  task: z
    .object({
      category,
      spec: z.string().min(1).max(4000),
      deadline: isoUtc,
      max_verify_seconds: z.number().int().positive(),
    })
    .strict(),
  verifier: z
    .object({
      public_id: publicId,
      endpoint: z.url(),
      package_sha256: hex32,
      entrypoint: z.string().min(1),
      rule: z.literal("EXIT_0_AND_SCHEMA_VALID"),
    })
    .strict(),
  /** ADR-021: upper bound on the HTLC lock window, seconds. */
  max_lock_seconds: z.number().int().positive(),
  /** ADR-021: margin added to deadline + max_verify_seconds, seconds. */
  safety_margin_seconds: z.number().int().nonnegative(),
  /** 0.1.3: hashObj({ cap_hash, intent }) of the SPEND_INTENT body this contract fulfils. */
  intent_sha256: hex32,
};

/** TASK_OFFER: signed by the buyer only. */
export const offeredContractSchema = z
  .object({
    ...contractBase,
    signatures: z.object({ buyer: signatureString, worker: signatureString.optional() }).strict(),
  })
  .strict();
/** TASK_ACCEPT and later: both signatures. */
export const taskContractSchema = z
  .object({
    ...contractBase,
    signatures: z.object({ buyer: signatureString, worker: signatureString }).strict(),
  })
  .strict();
export type TaskContract = z.infer<typeof taskContractSchema>;
export type OfferedContract = z.infer<typeof offeredContractSchema>;

/** `task_` + first 16 hex of hashObj(unsigned contract). */
export function taskId(contract: Record<string, unknown>): string {
  return `task_${hashUnsigned(contract).slice(0, 16)}`;
}

/**
 * Verdict `contract_sha256`: hashUnsigned(contract), i.e. all signature fields stripped.
 * This is the same hash both parties sign, so re-signing never changes it.
 */
export function contractHash(contract: Record<string, unknown>): string {
  return hashUnsigned(contract);
}

export const verdictRecordSchema = z
  .object({
    task_id: taskIdSchema,
    contract_sha256: hex32,
    delivery_sha256: hex32,
    verifier_package_sha256: hex32,
    attempt: z.number().int().min(1),
    checks: z.array(
      z.object({ id: z.string().min(1).max(64), status: z.enum(["PASS", "FAIL"]) }).strict(),
    ),
    exit_code: z.number().int(),
    verdict: z.enum(["RELEASE", "WITHHOLD"]),
    payment_hash: paymentHash,
    /** integer unix seconds */
    timestamp: z.number().int().nonnegative(),
    verifier_sig: signatureString,
  })
  .strict();
export type VerdictRecord = z.infer<typeof verdictRecordSchema>;
