import { z } from "zod";
import { BLOCK_CODES, type BlockCode } from "./blocks.js";
import { childCapabilitySchema, rootCapabilitySchema, spendIntentSchema } from "./capability.js";
import { offeredContractSchema, taskContractSchema, verdictRecordSchema } from "./contract.js";
import {
  capIdSchema,
  hex32,
  isoUtc,
  paymentHash,
  preimageHex,
  publicId,
  signatureString,
  taskIdSchema,
} from "./primitives.js";
import { WIRE_VERSION } from "./version.js";

const base64 = z
  .string()
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/, "expected base64");
const blockCode = z.custom<BlockCode>(
  (v) => typeof v === "string" && (BLOCK_CODES as string[]).includes(v),
);

/** 32-byte preimage sealed with crypto_box_seal: 80 bytes = 108 base64 chars. */
export const sealedPreimage = base64.length(108);
/** Cap on DELIVER bundles: 10 MiB of base64 is about 7.5 MiB of tar.gz. */
export const MAX_BUNDLE_B64_CHARS = 10 * 1024 * 1024;

export const bodies = {
  CAP_ROOT: rootCapabilitySchema,
  CAP_CHILD: childCapabilitySchema,
  /** Signed by the child capability holder (the buyer id). */
  SPEND_INTENT: z.object({ cap_hash: hex32, intent: spendIntentSchema }).strict(),
  /** Engine answer to a refused message. intent_sha256 = hashObj(intent). */
  REFUSAL: z
    .object({
      code: blockCode,
      message: z.string().min(1),
      details: z.record(z.string(), z.unknown()).optional(),
      intent_sha256: hex32,
    })
    .strict(),
  TASK_OFFER: offeredContractSchema,
  TASK_ACCEPT: taskContractSchema,
  P_DEPOSIT: z.object({ contract: taskContractSchema, sealed_preimage: sealedPreimage }).strict(),
  P_CONFIRM: z
    .object({
      task_id: taskIdSchema,
      payment_hash: paymentHash,
      package_sha256: hex32,
      confirmed: z.literal(true),
    })
    .strict(),
  HODL_INVOICE: z
    .object({
      bolt11: z.string().regex(/^ln[a-z0-9]+$/, "expected lowercase bolt11"),
      payment_hash: paymentHash,
    })
    .strict(),
  ESCROW_LOCKED: z.object({ payment_hash: paymentHash, status: z.literal("Pending") }).strict(),
  DELIVER: z
    .object({
      attempt: z.number().int().min(1),
      delivery_sha256: hex32,
      bundle_b64: base64.max(MAX_BUNDLE_B64_CHARS),
      self_check_exit_code: z.number().int(),
    })
    .strict(),
  VERDICT: verdictRecordSchema,
  APPROVE: z
    .object({ task_id: taskIdSchema, payment_hash: paymentHash, confirmed: z.literal(true) })
    .strict(),
  PREIMAGE: z
    .object({
      payment_hash: paymentHash,
      preimage_hex: preimageHex,
      reason: z.enum(["VERDICT_RELEASE", "PRINCIPAL_APPROVE"]),
    })
    .strict(),
  CLAIMED: z.object({ payment_hash: paymentHash }).strict(),
  REFUNDED: z.object({ payment_hash: paymentHash }).strict(),
  BLOCKED: z
    .object({
      code: blockCode,
      message: z.string().min(1),
      intent: z.unknown(),
      cap_id: capIdSchema.nullable(),
    })
    .strict(),
} as const;

/** Wire shapes of the engine answer to POST /v0/messages. */
export const refusalResponseSchema = z
  .object({ ok: z.literal(false), ...bodies.REFUSAL.shape })
  .strict();
export const acceptanceSchema = z
  .object({ ok: z.literal(true), cap_id: capIdSchema.optional() })
  .strict();
export type RefusalResponse = z.infer<typeof refusalResponseSchema>;
export type Acceptance = z.infer<typeof acceptanceSchema>;

export type MessageType = keyof typeof bodies;
export const MESSAGE_TYPES = Object.keys(bodies) as MessageType[];
export type MessageBody<T extends MessageType> = z.infer<(typeof bodies)[T]>;

/** Types that travel as signed envelopes over POST /v0/messages. The rest are UI events only. */
export const ENVELOPE_TYPES = [
  "SPEND_INTENT",
  "TASK_OFFER",
  "TASK_ACCEPT",
  "P_DEPOSIT",
  "P_CONFIRM",
  "HODL_INVOICE",
  "ESCROW_LOCKED",
  "DELIVER",
  "VERDICT",
  "APPROVE",
  "PREIMAGE",
  "CLAIMED",
] as const satisfies readonly MessageType[];
export type EnvelopeType = (typeof ENVELOPE_TYPES)[number];

const envelopeFields = {
  v: z.literal(WIRE_VERSION),
  id: z.uuid(),
  task_id: taskIdSchema,
  from: publicId,
  to: publicId,
  sent_at: isoUtc,
  sig: signatureString,
};

function envelopeOf<T extends EnvelopeType>(type: T) {
  return z.object({ ...envelopeFields, type: z.literal(type), body: bodies[type] }).strict();
}

export const envelopeSchema = z.discriminatedUnion("type", [
  envelopeOf("SPEND_INTENT"),
  envelopeOf("TASK_OFFER"),
  envelopeOf("TASK_ACCEPT"),
  envelopeOf("P_DEPOSIT"),
  envelopeOf("P_CONFIRM"),
  envelopeOf("HODL_INVOICE"),
  envelopeOf("ESCROW_LOCKED"),
  envelopeOf("DELIVER"),
  envelopeOf("VERDICT"),
  envelopeOf("APPROVE"),
  envelopeOf("PREIMAGE"),
  envelopeOf("CLAIMED"),
]);
export type Envelope = z.infer<typeof envelopeSchema>;

/** Receivers reject sent_at outside +-120 s. */
export const MAX_CLOCK_SKEW_SECONDS = 120;
export function isFresh(sentAt: string, nowMs: number): boolean {
  const t = Date.parse(sentAt);
  return Number.isFinite(t) && Math.abs(nowMs - t) <= MAX_CLOCK_SKEW_SECONDS * 1000;
}
