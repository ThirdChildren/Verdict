import type { UiEvent } from "@verdict/protocol";
import { type AppState, blockKey } from "../store.js";

/** The task an event belongs to, or null for events that are not task-scoped (mandate, budget, blocks). */
export function eventTaskId(e: UiEvent, s: Pick<AppState, "tasks">): string | null {
  if ("task_id" in e.data && typeof e.data.task_id === "string") return e.data.task_id;
  if ("payment_hash" in e.data) {
    const h = e.data.payment_hash;
    for (const [id, t] of Object.entries(s.tasks)) if (t.paymentHash === h) return id;
  }
  return null;
}

/** Raw messages for the selection: a blocked attempt shows its BLOCKED message, a task its own plus the mandate ones. */
export function eventsFor(
  s: Pick<AppState, "events" | "tasks" | "selected" | "currentTask">,
): UiEvent[] {
  const sel = s.selected ?? s.currentTask;
  if (sel?.startsWith("block:")) return s.events.filter((e) => blockKey(e.seq) === sel);
  // The child capability of this task is the newest one issued before its first event.
  const firstSeq = sel ? s.tasks[sel]?.seq : undefined;
  const child =
    firstSeq === undefined
      ? undefined
      : s.events.find((e) => e.type === "CAP_CHILD" && e.seq <= firstSeq);
  return s.events.filter(
    (e) => e.type === "CAP_ROOT" || e === child || (sel !== null && eventTaskId(e, s) === sel),
  );
}
