import { z } from "zod";
import { parseTaskTypes, type TaskType } from "./taskTypes.js";

/**
 * UI-only engine event "a request was refused because it cannot be verified" (not part of the frozen protocol).
 *   { "type": "TASK_REFUSED", "reason": "<plain text>", "task_types": [{ id, description, format }] }
 * The fields may also sit under `data`. `at` is optional.
 */
const body = z.object({
  reason: z.string(),
  task_types: z.unknown().optional(),
  at: z.string().optional(),
});
const envelope = z.object({ type: z.literal("TASK_REFUSED"), data: body.optional() }).passthrough();

export interface TaskRefusal {
  reason: string;
  task_types: TaskType[];
  at?: string | undefined;
}

export function parseRefusedEvent(raw: unknown): TaskRefusal | null {
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  const e = envelope.safeParse(value);
  if (!e.success) return null;
  const b = body.safeParse(e.data.data ?? value);
  if (!b.success) return null;
  // Entries are full objects or bare ids.
  const listed = Array.isArray(b.data.task_types) ? b.data.task_types : [];
  const entries = listed.map((t) =>
    typeof t === "string" ? { id: t, title: t, description: "", format: 1 } : t,
  );
  const types = parseTaskTypes({ task_types: entries }) ?? [];
  return { reason: b.data.reason, task_types: types, ...(b.data.at ? { at: b.data.at } : {}) };
}
