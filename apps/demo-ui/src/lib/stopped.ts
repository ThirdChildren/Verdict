import { useEffect, useState } from "react";
import type { Live } from "../components/WorkerLane.js";
import type { AppState, TaskView } from "../store.js";

/** Silence after the lock (no tokens, no delivery) before the worker counts as stopped. Configurable. */
export const WORKER_STOPPED_AFTER_MS: number = (() => {
  const raw = Number(import.meta.env?.VITE_WORKER_STOPPED_AFTER_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 20_000;
})();

/** Backend hint, if it ever emits one (adapter: accepts a few spellings, ignores anything else). */
export function workerStoppedHint(data: unknown): boolean | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const d = data as Record<string, unknown>;
  const v = d.worker_status ?? d.workerStatus;
  if (v === "stopped") return true;
  if (v === "working" || v === "active") return false;
  return undefined;
}

/**
 * The worker took the job, the funds are locked and nothing came back: no tokens and no delivery for
 * `afterMs` since the lock. Derived on the client from task and stream events.
 */
export function isWorkerStopped(
  task: Pick<TaskView, "state" | "stepAt" | "workerStopped">,
  now: number,
  streaming = false,
  afterMs: number = WORKER_STOPPED_AFTER_MS,
): boolean {
  if (task.state !== "ESCROW_LOCKED") return false;
  if (task.workerStopped === true) return true;
  if (task.workerStopped === false || streaming) return false;
  const lockAt = task.stepAt[2];
  return lockAt !== undefined && now - Date.parse(lockAt) > afterMs;
}

export const isStreaming = (live: Live | null, id: string): boolean =>
  !!live && live.key.startsWith(`${id}:`) && live.tokens > 0;

/** Ids of the tasks whose worker has stopped responding. */
export function stoppedIds(s: AppState, now: number, live: Live | null): Set<string> {
  const out = new Set<string>();
  for (const [id, t] of Object.entries(s.tasks))
    if (isWorkerStopped(t, now, isStreaming(live, id))) out.add(id);
  return out;
}

/** A clock that ticks every second while `active`. */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}
