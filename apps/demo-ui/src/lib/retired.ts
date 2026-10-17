import { z } from "zod";

/**
 * The engine's own UI event for "a new mandate replaced the old one" (not part of the frozen protocol, like
 * DEMO_MINE_PROGRESS). Sent before the new CAP_ROOT. Shape:
 *   { "type": "MANDATE_RETIRED", "cap_hash": "<new root>", "retired": ["<old root>", ...], "reason": "<plain text>" }
 * `at` is optional. The earlier draft shape { cap_id, replaced_by, in_flight, message } is read as well.
 */
const current = z.object({
  type: z.literal("MANDATE_RETIRED"),
  cap_hash: z.string(),
  retired: z.array(z.string()),
  reason: z.string(),
  at: z.string().optional(),
});
const draft = z.object({
  type: z.literal("MANDATE_RETIRED"),
  cap_id: z.string(),
  replaced_by: z.string().optional(),
  in_flight: z.number().optional(),
  message: z.string(),
  at: z.string().optional(),
});

export interface MandateRetired {
  /** The new root. */
  cap_hash: string;
  /** The roots that were retired. */
  retired: string[];
  reason: string;
  at?: string | undefined;
}

export function parseRetiredEvent(raw: unknown): MandateRetired | null {
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  const a = current.safeParse(value);
  if (a.success) {
    const { type: _t, ...rest } = a.data;
    return rest;
  }
  const b = draft.safeParse(value);
  if (!b.success) return null;
  return {
    cap_hash: b.data.replaced_by ?? "",
    retired: [b.data.cap_id],
    reason: b.data.message,
    ...(b.data.at ? { at: b.data.at } : {}),
  };
}
