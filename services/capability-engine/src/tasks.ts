import { canTransition, type TaskState } from "@verdict/protocol";
import type { EventBus } from "./events.js";

export const DEFAULT_WORKER_SILENCE_MS = 20_000;

/**
 * Engine view of each task's state (ARCHITECTURE 7.1). Every change goes through the protocol's transition table and is
 * announced to the UI; a move the table does not allow is refused and nothing is published. Money never depends on this
 * map: the ledger and wallet events decide that.
 */
export class TaskTracker {
  private readonly state = new Map<string, TaskState>();

  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  /**
   * `silenceMs`: how long an ESCROW_LOCKED task may stay without a delivery before the UI is told the worker stopped
   * (WORKER_STATUS "stopped"). Display only: nothing here moves money or the task state.
   */
  constructor(
    private readonly bus: EventBus,
    private readonly now: () => Date,
    private readonly silenceMs: number = DEFAULT_WORKER_SILENCE_MS,
  ) {}

  /** A task the engine knows about starts as OFFERED (published by the offer service). */
  current(taskId: string): TaskState {
    return this.state.get(taskId) ?? "OFFERED";
  }

  move(taskId: string, to: TaskState, attempt?: number): boolean {
    const from = this.current(taskId);
    if (from === to) return true;
    if (!canTransition(from, to)) return false;
    this.state.set(taskId, to);
    const old = this.timers.get(taskId);
    if (old) clearTimeout(old);
    this.timers.delete(taskId);
    if (to === "ESCROW_LOCKED") this.watch(taskId);
    this.bus.publish(
      {
        type: "TASK_STATE",
        data: { task_id: taskId, state: to, ...(attempt === undefined ? {} : { attempt }) },
      },
      this.now(),
    );
    return true;
  }

  private watch(taskId: string): void {
    const t = setTimeout(() => {
      this.timers.delete(taskId);
      if (this.current(taskId) !== "ESCROW_LOCKED") return;
      this.bus.publish(
        {
          type: "WORKER_STATUS",
          data: {
            task_id: taskId,
            worker_status: "stopped",
            silent_seconds: Math.round(this.silenceMs / 1000),
            message:
              "The worker accepted the task and the money is locked, but it has not delivered anything. The payment stays held and refunds on its own when the lock runs out.",
          },
        },
        this.now(),
      );
    }, this.silenceMs);
    t.unref?.();
    this.timers.set(taskId, t);
  }
}
