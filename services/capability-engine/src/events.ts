import type { UiEvent } from "@verdict/protocol";

import type { DemoMineProgressEvent } from "./api/demo.js";

/** Not part of the frozen protocol: the engine tells the UI a locked task's worker has gone silent. */
export interface WorkerStatusEvent {
  seq: number;
  at: string;
  type: "WORKER_STATUS";
  data: { task_id: string; worker_status: "stopped"; silent_seconds: number; message: string };
}

/** Not part of the frozen protocol: a newer mandate replaced the older ones (sent before the new CAP_ROOT). */
export interface MandateRetiredEvent {
  seq: number;
  at: string;
  type: "MANDATE_RETIRED";
  /** Hash of the new root. */
  cap_hash: string;
  /** cap_id of each retired root, followed by the cap_ids of its retired children. */
  retired: string[];
  reason: string;
}

export type EngineEvent = UiEvent | DemoMineProgressEvent | WorkerStatusEvent | MandateRetiredEvent;
type Listener = (e: EngineEvent) => void;
type Distribute<T> = T extends { seq: number } ? Omit<T, "seq" | "at"> : never;

/** In-process UI event bus. Events never carry the preimage. */
export class EventBus {
  private seq = 0;
  private readonly listeners = new Set<Listener>();
  private readonly history: EngineEvent[] = [];

  publish(e: Distribute<EngineEvent>, now: Date): EngineEvent {
    const full = { ...e, seq: this.seq++, at: now.toISOString() } as EngineEvent;
    this.history.push(full);
    if (this.history.length > 500) this.history.shift();
    for (const l of this.listeners) l(full);
    return full;
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  replay(): readonly EngineEvent[] {
    return this.history;
  }
}
