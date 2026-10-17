import { uiEventSchema } from "@verdict/protocol";
import { useEffect, useRef, useState } from "react";
import {
  fetchWorkerConfig,
  fetchWorkerTasks,
  setWorkerConfig,
  type WorkerConfig,
  type WorkerTaskView,
  workerStreamUrl,
} from "../lib/workerApi.js";
import { useStore } from "../store.js";

const WORD: Record<string, string> = {
  PASS: "passed its own check",
  FAIL: "failed its own check",
  WITHHOLD: "could not be checked locally",
  "not run": "not checked",
};

/** A task that has sat at "invoice sent" this long has a payment that is not arriving: say so, never hang silently. */
export const STALL_MS = 45_000;
export function stalledReason(
  state: string | undefined,
  sinceMs: number | null,
  nowMs: number,
): string | null {
  if (state !== "INVOICE_SENT" || sinceMs === null || nowMs - sinceMs < STALL_MS) return null;
  return "The buyer's payment has not reached the worker's wallet after 45 seconds, so the work has not started and no money has moved. The Lightning channel is probably not working (for example the wallet daemons were restarted). Fix: run pnpm demo:reset, then start a new task.";
}

export interface Live {
  key: string;
  attempt: number;
  thinking: string;
  output: string;
  tokens: number;
  tps: number | null;
  done: boolean;
}
const TAIL = 700;
const tail = (s: string) => (s.length > TAIL ? `…${s.slice(-TAIL)}` : s);

/** Live model output from the worker's own WebSocket (WORKER_STREAM). Reconnects quietly; the lane works without it. */
export function useLiveStream(enabled = true): Live | null {
  const [live, setLive] = useState<Live | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let ws: WebSocket | undefined;
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const open = () => {
      try {
        ws = new WebSocket(workerStreamUrl());
      } catch {
        return;
      }
      ws.onmessage = (m) => {
        let raw: unknown;
        try {
          raw = JSON.parse(String(m.data));
        } catch {
          return;
        }
        const p = uiEventSchema.safeParse(raw);
        if (!p.success || p.data.type !== "WORKER_STREAM") return;
        const d = p.data.data;
        const key = `${d.task_id}:${d.attempt}`;
        setLive((cur) => {
          const base: Live =
            cur && cur.key === key
              ? cur
              : {
                  key,
                  attempt: d.attempt,
                  thinking: "",
                  output: "",
                  tokens: 0,
                  tps: null,
                  done: false,
                };
          return {
            ...base,
            thinking: d.channel === "thinking" ? tail(base.thinking + d.text) : base.thinking,
            output: d.channel === "output" ? tail(base.output + d.text) : base.output,
            tokens: d.tokens,
            tps: d.tokens_per_sec ?? base.tps,
            done: d.channel === "done",
          };
        });
      };
      ws.onclose = () => {
        if (!stop) timer = setTimeout(open, 3000);
      };
    };
    open();
    return () => {
      stop = true;
      clearTimeout(timer);
      ws?.close();
    };
  }, [enabled]);
  return live;
}

/** Worker lane: what the worker's local model is doing (attempt n/3) and the labelled "Sabotaged worker" demo switch. */
/** What the worker really has switched on, in words. Empty when nothing is on. */
export function toggleLabels(
  t: { sabotaged?: boolean | undefined; disappears?: boolean | undefined } | undefined,
): string[] {
  const out: string[] = [];
  if (t?.sabotaged) out.push("SABOTAGED");
  if (t?.disappears) out.push("WILL DISAPPEAR");
  return out;
}

export function WorkerLane() {
  const [task, setTask] = useState<WorkerTaskView | null>(null);
  const [config, setConfig] = useState<WorkerConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Bumped on every switch change: a poll that started before the change must not overwrite what the worker just said.
  const version = useRef(0);
  // When the shown task was first seen waiting for the payment (client clock; only used to flag a stall).
  const waiting = useRef<{ id: string; since: number } | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let stop = false;
    const tick = async () => {
      const v = version.current;
      try {
        const [tasks, cfg] = await Promise.all([fetchWorkerTasks(), fetchWorkerConfig()]);
        if (stop) return;
        const latest = tasks[tasks.length - 1] ?? null;
        if (latest?.state === "INVOICE_SENT") {
          if (waiting.current?.id !== latest.taskId)
            waiting.current = { id: latest.taskId, since: Date.now() };
        } else waiting.current = null;
        setNow(Date.now());
        setTask(latest);
        if (v === version.current) setConfig(cfg);
        useStore.getState().setConnection("worker", "connected");
      } catch {
        if (!stop) useStore.getState().setConnection("worker", "disconnected");
      }
    };
    void tick();
    const id = setInterval(tick, 2000);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, []);

  const toggle = async (change: Partial<WorkerConfig>) => {
    setError(null);
    version.current += 1;
    try {
      // The worker's answer is the truth: the checkbox and the badge show what it reports, not what was clicked.
      setConfig(await setWorkerConfig(change));
    } catch (e) {
      // No silent no-op: the box stays as the worker last reported it and the failure is shown.
      setError(
        `${e instanceof Error ? e.message : "The switch could not be changed."} The switch was not changed.`,
      );
    }
  };

  const stalled = stalledReason(task?.state, waiting.current?.since ?? null, now);
  const live = useLiveStream();
  const last = task?.attempts?.[task.attempts.length - 1];
  return (
    <section
      aria-label="Worker"
      className="rounded-2xl border border-rule-soft bg-card p-4 shadow-soft"
    >
      <h2 className="text-xl font-semibold">Worker</h2>
      <p aria-live="polite" className="mt-2">
        {!task && "Waiting for a task."}
        {task?.state === "GENERATING" &&
          `Writing the deliverable with the local model: attempt ${task.progress?.attempt ?? 1}/${task.progress?.max_attempts ?? 3}.`}
        {task && task.state !== "GENERATING" && task.progress && task.attempts && (
          <>
            Delivered after attempt {task.attempts.length}/{task.progress.max_attempts}
            {last ? `: the file ${WORD[last.self_check]}` : ""}
            {last?.tokens_per_sec ? ` (${last.tokens_per_sec} tokens/s)` : ""}. The verifier
            decides, not the worker.
          </>
        )}
        {task && task.state !== "GENERATING" && !task.attempts && `Task state: ${task.state}.`}
        {task?.state === "CLAIMED" &&
          " The verifier released the secret and the worker claimed the payment."}
        {task?.state === "CANCELLED" &&
          " The verifier rejected the delivery, so the worker cancelled the invoice and the buyer's funds were released."}
        {task?.state === "ABANDONED" &&
          " The worker has gone silent (demo switch). The buyer's funds stay locked until the Lightning lock runs out."}
      </p>
      {stalled && (
        <p
          role="alert"
          data-testid="task-stalled"
          className="mt-2 border-l-2 border-ink pl-3 font-semibold"
        >
          {stalled}
        </p>
      )}
      {live && (
        <section
          className="mt-3 rounded-xl border border-rule-soft bg-surface/50 p-3"
          aria-label="Live model output"
        >
          <p className="font-mono text-base font-semibold">
            Attempt {live.attempt}: {live.done ? "finished" : "writing"} · {live.tokens} tokens
            {live.tps !== null ? ` · ${live.tps} tokens/s` : ""}
          </p>
          {live.thinking && (
            <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap text-sm italic text-subtle">
              {live.thinking}
            </pre>
          )}
          {live.output && (
            <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap font-mono text-sm">
              {live.output}
            </pre>
          )}
        </section>
      )}
      {toggleLabels(config ?? undefined).length > 0 && (
        <p
          aria-live="polite"
          data-testid="toggle-badge"
          className="mt-2 border-l-2 border-ink pl-3 font-semibold"
        >
          {toggleLabels(config ?? undefined).join(" + ")} - applies from the next task
        </p>
      )}
      {task?.toggles && toggleLabels(task.toggles).length > 0 && (
        <p data-testid="task-toggles" className="mt-2 text-base">
          This task started with: {toggleLabels(task.toggles).join(" + ")}.
        </p>
      )}
      {task?.sabotaged && (
        <p className="mt-2 border-l-2 border-ink pl-3 font-semibold">
          This delivery came from the sabotaged worker (demo switch). It is broken on purpose.
        </p>
      )}
      <label className="mt-3 flex items-center gap-3 text-base font-semibold">
        <input
          type="checkbox"
          className="size-5 accent-ink"
          checked={config?.sabotaged ?? false}
          disabled={config === null}
          onChange={(e) => void toggle({ sabotaged: e.target.checked })}
        />
        Sabotaged worker (demo only): delivers a broken file on purpose, to show the refund
      </label>
      {config?.disappears !== undefined && (
        <label className="mt-2 flex items-center gap-3 text-base font-semibold">
          <input
            type="checkbox"
            className="size-5 accent-ink"
            checked={config.disappears}
            onChange={(e) => void toggle({ disappears: e.target.checked })}
          />
          Worker disappears (demo only): never claims and never cancels, so the funds come back only
          when the lock runs out
        </label>
      )}
      {error && (
        <p role="alert" className="mt-2 font-semibold">
          {error}
        </p>
      )}
    </section>
  );
}
