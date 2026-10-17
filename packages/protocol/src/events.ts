import { z } from "zod";
import { bodies } from "./messages.js";
import { amountString, capIdSchema, isoUtc, paymentHash, taskIdSchema } from "./primitives.js";
import { PAYMENT_STATUSES, TASK_STATES } from "./states.js";

const ev = <T extends string, S extends z.ZodType>(type: T, data: S) =>
  z
    .object({ seq: z.number().int().nonnegative(), at: isoUtc, type: z.literal(type), data })
    .strict();

/**
 * UI events are NOT part of the frozen protocol surface (PROTOCOL_VERSION does not cover them).
 * They version independently; bump on any change to uiEventSchema.
 */
export const UI_EVENTS_VERSION = "0.4.0";

/** Events pushed to the UI over WebSocket. */
export const uiEventSchema = z.discriminatedUnion("type", [
  ev("CAP_ROOT", bodies.CAP_ROOT),
  ev("CAP_CHILD", bodies.CAP_CHILD),
  ev("BLOCKED", bodies.BLOCKED),
  ev("REFUNDED", bodies.REFUNDED),
  ev(
    "TASK_STATE",
    z
      .object({
        task_id: taskIdSchema,
        state: z.enum(TASK_STATES),
        attempt: z.number().int().min(1).optional(),
      })
      .strict(),
  ),
  ev(
    "PAYMENT_STATUS",
    z
      .object({
        task_id: taskIdSchema,
        payment_hash: paymentHash,
        status: z.enum(PAYMENT_STATUSES),
      })
      .strict(),
  ),
  /** Worker lane: live model output. Served by the worker's own WebSocket, not the engine's. */
  ev(
    "WORKER_STREAM",
    z
      .object({
        task_id: taskIdSchema,
        attempt: z.number().int().min(1),
        channel: z.enum(["thinking", "output", "done"]),
        /** A batch of text from the model; empty on "done". */
        text: z.string().max(8000),
        /** Tokens generated so far in this attempt, thinking included. */
        tokens: z.number().int().nonnegative(),
        tokens_per_sec: z.number().nonnegative().nullable(),
      })
      .strict(),
  ),
  ev("PAYMENT_CONFIRMING", z.object({ task_id: taskIdSchema, payment_hash: paymentHash }).strict()),
  ev("VERDICT", bodies.VERDICT),
  ev("CLAIMED", bodies.CLAIMED),
  ev(
    "BUDGET_UPDATED",
    z
      .object({
        cap_id: capIdSchema,
        remaining: amountString,
        reserved: amountString,
        committed: amountString,
      })
      .strict(),
  ),
]);
export type UiEvent = z.infer<typeof uiEventSchema>;
