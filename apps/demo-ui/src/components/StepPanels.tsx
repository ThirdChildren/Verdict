import type { VerdictRecord } from "@verdict/protocol";
import { useEffect, useRef } from "react";
import { PAYMENT_CAPTIONS, VERDICT_CAPTIONS } from "../lib/captions.js";
import type { ChainInfo } from "../lib/queries.js";
import { useEvidence } from "../lib/queries.js";
import type { TaskView } from "../store.js";
import { BlockRing, Timeline } from "./PaymentTimeline.js";
import type { Live } from "./WorkerLane.js";

export const MAX_ATTEMPTS = 3;

/** Live model output: fixed height, follows the newest tokens, fades at the top edge. */
function WorkerOutput({ text }: { text: string }) {
  const ref = useRef<HTMLPreElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll whenever the text grows
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [text]);
  return (
    <pre
      ref={ref}
      role="log"
      aria-live="off"
      aria-label="Live model output"
      className="h-[132px] overflow-y-auto border border-rule p-3 font-mono text-base whitespace-pre-wrap [mask-image:linear-gradient(to_bottom,transparent,black_1.5rem)]"
    >
      {text || "Waiting for the first tokens…"}
    </pre>
  );
}

export function WorkPanel(props: { live: Live | null; attempt: number; stopped?: boolean }) {
  const { live } = props;
  const text = live ? live.output || live.thinking : "";
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center gap-3 text-base">
        <span className="font-semibold">Worker model, on this machine</span>
        <span className="ml-auto flex items-center gap-3">
          {live?.tps != null && (
            <span className="tabular-nums text-subtle">{live.tps.toFixed(1)} tok/s</span>
          )}
          <span className="font-mono">
            attempt {props.attempt}/{MAX_ATTEMPTS}
          </span>
        </span>
      </div>
      {props.stopped && (
        <p className="text-xl font-semibold">
          <span aria-hidden>▲ </span>
          Worker stopped responding
        </p>
      )}
      <WorkerOutput text={text} />
    </div>
  );
}

export function VerifyPanel(props: {
  taskId: string;
  verdict: VerdictRecord | null;
  skipped?: boolean;
}) {
  const v = props.verdict;
  if (props.skipped && !v)
    return (
      <p aria-live="polite" className="text-xl font-semibold text-subtle">
        Skipped — nothing delivered. The verifier never ran.
      </p>
    );
  if (!v)
    return (
      <p className="text-base text-subtle">
        The verifier holds the secret and is waiting for the delivery.
      </p>
    );
  const pass = v.verdict === "RELEASE";
  return (
    <div className="grid gap-4">
      <p aria-live="polite" className="text-4xl font-semibold">
        <span aria-hidden>■ </span>
        {pass ? "PASS" : "FAIL"}
      </p>
      <p className="text-base">{VERDICT_CAPTIONS[v.verdict]}</p>
      <ul className="grid gap-1 text-base">
        {v.checks.length === 0 && <li className="text-subtle">No check ran.</li>}
        {v.checks.map((c) => (
          <li key={c.id} className="font-mono">
            <span aria-hidden>{c.status === "PASS" ? "■" : "×"} </span>
            {c.id}: {c.status === "PASS" ? "passed" : "failed"}
          </li>
        ))}
      </ul>
      <p className="text-base text-subtle">
        Exit code {v.exit_code} · attempt {v.attempt}/{MAX_ATTEMPTS} · package hash and log in
        Details
      </p>
    </div>
  );
}

const secondsBetween = (a?: string, b?: string): number | null =>
  a && b ? Math.max(0, Math.round((Date.parse(b) - Date.parse(a)) / 1000)) : null;

/** First lines of the delivered output, mono, for the outcome card. */
export function previewLines(content: string, max = 4): string {
  const lines = content.split("\n");
  const head = lines.slice(0, max).join("\n");
  return lines.length > max ? `${head}\n…` : head;
}

/** Outcome block: who was paid, that it was verified, how long it took, and a peek at what was delivered. */
function PaidCard(props: {
  taskId: string;
  task: TaskView;
  worker: string;
  verifiedPass: boolean;
}) {
  const { task } = props;
  const evidence = useEvidence(props.taskId, task.state, props.verifiedPass ? 1 : 0);
  const secs = secondsBetween(task.stepAt[0], task.stepAt[4]);
  const file =
    evidence.data?.task_id === props.taskId ? evidence.data.delivery?.files[0] : undefined;
  return (
    <div role="status" className="grid gap-1 border-y-2 border-ink py-2">
      <p className="text-xl font-semibold uppercase">
        Paid {task.amount ?? "—"} tUSD to {props.worker}
        {props.verifiedPass ? " · verified PASS" : ""}
        {secs !== null ? ` · ${secs} s` : ""}
      </p>
      {file && (
        <>
          <p className="text-base">Delivered: {file.path}</p>
          <pre className="max-h-16 overflow-hidden border border-rule px-3 py-1 font-mono text-base whitespace-pre-wrap">
            {previewLines(file.content, 2)}
          </pre>
        </>
      )}
    </div>
  );
}

/** Outcome block after a refund: the money is back in the budget. */
function RefundedCard(props: { task: TaskView; verifiedFail: boolean }) {
  const { task } = props;
  const secs = secondsBetween(task.stepAt[0], task.stepAt[4]);
  return (
    <div role="status" className="border-y-2 border-ink py-2">
      <p className="text-xl font-semibold uppercase">
        Refunded {task.amount ?? "—"} tUSD to you
        {props.verifiedFail ? " · verified FAIL" : ""}
        {secs !== null ? ` · ${secs} s` : ""}
      </p>
    </div>
  );
}

export function SettlePanel(props: {
  taskId: string;
  task: TaskView;
  chain: ChainInfo | null;
  worker: string;
  verifiedPass: boolean;
  verifiedFail?: boolean;
  /** Payment held with no claim or cancel to expect: FAIL held over 10 s, or the worker stopped responding. */
  held?: boolean;
}) {
  const { task } = props;
  const last = task.payHistory[task.payHistory.length - 1]?.status;
  const paid = task.state === "CLAIMED";
  const refunded = task.state === "REFUNDED";
  const ring =
    props.held &&
    props.chain &&
    (task.state === "VERDICT_WITHHOLD" || task.state === "ESCROW_LOCKED");
  return (
    <div className="grid gap-3">
      {last ? (
        <>
          <Timeline history={task.payHistory} />
          {!paid && !refunded && !ring && (
            <p className="text-base text-subtle">{PAYMENT_CAPTIONS[last]}</p>
          )}
        </>
      ) : (
        <p className="text-base text-subtle">No escrow payment has been reported yet.</p>
      )}
      {paid && (
        <PaidCard
          taskId={props.taskId}
          task={task}
          worker={props.worker}
          verifiedPass={props.verifiedPass}
        />
      )}
      {refunded && <RefundedCard task={task} verifiedFail={props.verifiedFail ?? false} />}
      {ring && props.chain && <BlockRing chain={props.chain} />}
    </div>
  );
}
