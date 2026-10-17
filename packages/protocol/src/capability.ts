import { z } from "zod";
import { hashObj, stripSignatures } from "./canonical.js";
import {
  action,
  amountString,
  assetId,
  capIdSchema,
  category,
  hex32,
  isoUtc,
  positiveAmountString,
  publicId,
  signatureString,
} from "./primitives.js";

export const CAP_VERSION = "verdict-cap/0";

export const rootCapabilitySchema = z
  .object({
    version: z.literal(CAP_VERSION),
    cap_id: capIdSchema,
    issuer: publicId,
    subject: z.string().min(1).max(64),
    asset_id: assetId,
    max_total: positiveAmountString,
    max_per_task: positiveAmountString,
    allowed_actions: z.array(action).min(1),
    allowed_categories: z.array(category).min(1),
    counterparties: z.literal("preapproved_workers"),
    /** Enforced by the engine (0.1.2); `counterparties` is legacy. */
    allowed_payees: z.array(publicId).min(1),
    recurring: z.literal(false),
    expires_at: isoUtc,
    parent: z.null(),
    signature: signatureString,
  })
  .strict();
export type RootCapability = z.infer<typeof rootCapabilitySchema>;

export const childCapabilitySchema = z
  .object({
    version: z.literal(CAP_VERSION),
    cap_id: capIdSchema,
    /** Full 64-hex sha256 of the signed parent capability (capabilityHash). cap_<16hex> ids are display/DB keys only. */
    parent: hex32,
    issuer: publicId,
    subject: z.string().min(1).max(64),
    asset_id: assetId,
    max_total: positiveAmountString,
    allowed_actions: z.array(action).min(1),
    allowed_categories: z.array(category).min(1),
    counterparties: z.array(publicId).min(1),
    allowed_payees: z.array(publicId).min(1),
    max_payments: z.number().int().min(1),
    recurring: z.literal(false),
    expires_at: isoUtc,
    signature: signatureString,
  })
  .strict();
export type ChildCapability = z.infer<typeof childCapabilitySchema>;

export const capabilitySchema = z.union([rootCapabilitySchema, childCapabilitySchema]);
export type Capability = z.infer<typeof capabilitySchema>;

/** `cap_` + first 16 hex of hashObj(capability without cap_id and signature). */
export function capId(cap: Record<string, unknown>): string {
  const { cap_id: _omit, ...rest } = stripSignatures(cap);
  return `cap_${hashObj(rest).slice(0, 16)}`;
}

/** hashObj of the full signed capability (child.parent and contract.capability_hash). */
export function capabilityHash(cap: Capability): string {
  return hashObj(cap);
}

export const spendIntentSchema = z
  .object({
    kind: z.literal("task_payment"),
    category,
    counterparty: publicId,
    amount: positiveAmountString,
    recurring: z.boolean(),
    interval: z.string().min(1).max(32).nullable(),
    task_spec: z.string().min(1).max(4000),
    deadline: isoUtc,
    rationale: z.string().min(1).max(500),
  })
  .strict();
export type SpendIntent = z.infer<typeof spendIntentSchema>;

export { amountString };

/** Attenuation: child.allowed_payees must be a subset of parent.allowed_payees; reports the first offender (block PAYEE_NOT_IN_PARENT). */
export function payeesAttenuate(
  parent: { allowed_payees: readonly string[] },
  child: { allowed_payees: readonly string[] },
): { ok: true } | { ok: false; payee: string } {
  const allowed = new Set(parent.allowed_payees);
  for (const p of child.allowed_payees) if (!allowed.has(p)) return { ok: false, payee: p };
  return { ok: true };
}
