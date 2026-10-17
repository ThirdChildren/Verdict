import type { UiEvent } from "@verdict/protocol";
import type { StreamHooks } from "./agent/generate.js";

export type StreamEvent = Extract<UiEvent, { type: "WORKER_STREAM" }>;
type Listener = (e: StreamEvent) => void;

const FLUSH_MS = 150;

/**
 * Live model output for the UI worker lane. Tokens are batched (one frame per ~150 ms per channel) so a 60 tok/s model
 * does not become 60 frames/s. A small history lets a late-opened page replay the current attempt.
 */
export class StreamHub {
  private seq = 0;
  private readonly listeners = new Set<Listener>();
  private readonly history: StreamEvent[] = [];

  constructor(private readonly now: () => number = Date.now) {}

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  replay(): readonly StreamEvent[] {
    return this.history;
  }

  private publish(d: StreamEvent["data"]): void {
    const e: StreamEvent = {
      seq: this.seq++,
      at: new Date(this.now()).toISOString(),
      type: "WORKER_STREAM",
      data: d,
    };
    this.history.push(e);
    if (this.history.length > 400) this.history.shift();
    for (const l of this.listeners) l(e);
  }

  /** Hooks for one generation attempt. `done` sends the closing frame with the model's own tok/s when known. */
  attempt(taskId: string, attempt: number): StreamHooks {
    let tokens = 0;
    let first: number | null = null;
    let channel: "thinking" | "output" = "thinking";
    let buf = "";
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tps = (): number | null => {
      if (first === null || tokens < 2) return null;
      const s = (this.now() - first) / 1000;
      return s > 0 ? Number((tokens / s).toFixed(1)) : null;
    };
    const flush = (): void => {
      if (timer) clearTimeout(timer);
      timer = undefined;
      if (buf === "") return;
      const text = buf.slice(0, 8000);
      buf = "";
      this.publish({
        task_id: taskId,
        attempt,
        channel,
        text,
        tokens,
        tokens_per_sec: tps(),
      });
    };
    const push = (c: "thinking" | "output", t: string): void => {
      first ??= this.now();
      if (c !== channel) {
        flush();
        channel = c;
      }
      tokens++;
      buf += t;
      if (buf.length >= 4000) flush();
      else timer ??= setTimeout(flush, FLUSH_MS);
    };
    return {
      onThinking: (t) => push("thinking", t),
      onToken: (t) => push("output", t),
      done: (stats) => {
        flush();
        this.publish({
          task_id: taskId,
          attempt,
          channel: "done",
          text: "",
          tokens: stats?.tokens ?? tokens,
          tokens_per_sec: stats?.tokPerSec ?? tps(),
        });
      },
    };
  }
}
