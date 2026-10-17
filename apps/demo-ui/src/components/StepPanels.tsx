import type { VerdictRecord } from "@verdict/protocol";
import { Check, CheckCircle2, Cpu, RotateCcw, TriangleAlert, X, XCircle } from "lucide-react";
import { useEffect, useRef } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
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
      className="h-[180px] overflow-y-auto rounded-lg bg-muted p-4 font-mono text-base whitespace-pre-wrap [mask-image:linear-gradient(to_bottom,transparent,black_1.5rem)]"
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
        <span className="flex items-center gap-2 font-semibold">
          <Cpu aria-hidden className="size-4" />
          Worker model, on this machine
        </span>
        <span className="ml-auto flex items-center gap-3">
          {live?.tps != null && (
            <span className="tabular-nums text-muted-foreground">{live.tps.toFixed(1)} tok/s</span>
          )}
          <Badge variant="neutral">
            attempt {props.attempt}/{MAX_ATTEMPTS}
          </Badge>
        </span>
      </div>
      {props.stopped && (
        <p className="flex items-center gap-2 text-xl font-bold text-warn">
          <TriangleAlert aria-hidden className="size-6" />
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
      <p aria-live="polite" className="text-xl font-bold text-muted-foreground">
        Skipped — nothing delivered. The verifier never ran.
      </p>
    );
  if (!v)
    return (
      <p className="text-base text-muted-foreground">
        The verifier holds the secret and is waiting for the delivery.
      </p>
    );
  const pass = v.verdict === "RELEASE";
  const Icon = pass ? CheckCircle2 : XCircle;
  return (
    <div className="grid gap-4">
      <p
        aria-live="polite"
        className={`flex items-center gap-3 text-4xl font-bold ${pass ? "text-info" : "text-danger"}`}
      >
        <Icon aria-hidden className="size-10" />
        {pass ? "PASS" : "FAIL"}
      </p>
      <p className="text-base">{VERDICT_CAPTIONS[v.verdict]}</p>
      <ul className="grid gap-1 text-base">
        {v.checks.length === 0 && <li className="text-muted-foreground">No check ran.</li>}
        {v.checks.map((c) => (
          <li key={c.id} className="flex items-center gap-2">
            {c.status === "PASS" ? (
              <Check aria-hidden className="size-4 text-info" />
            ) : (
              <X aria-hidden className="size-4 text-danger" />
            )}
            {c.id}: {c.status === "PASS" ? "passed" : "failed"}
          </li>
        ))}
      </ul>
      <p className="text-base text-muted-foreground">
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

/** Green outcome card: who was paid, that it was verified, how long it took, and a peek at what was delivered. */
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
    <Alert
      variant="ok"
      role="status"
      className="grid gap-2 p-4 has-[>svg]:grid-cols-[calc(var(--spacing)*6)_1fr]"
    >
      <CheckCircle2 aria-hidden className="size-6!" />
      <AlertTitle className="line-clamp-none text-xl font-bold">
        Paid {task.amount ?? "—"} tUSD to {props.worker}
        {props.verifiedPass ? " · verified PASS" : ""}
        {secs !== null ? ` · ${secs} s` : ""}
      </AlertTitle>
      {file && (
        <AlertDescription className="col-start-2">
          <p className="mb-0.5 text-base">Delivered: {file.path}</p>
          <pre className="max-h-20 overflow-hidden rounded-md bg-card/70 px-3 py-2 font-mono text-base whitespace-pre-wrap text-foreground">
            {previewLines(file.content, 2)}
          </pre>
        </AlertDescription>
      )}
    </Alert>
  );
}

/** Blue outcome card after a refund: the money is back in the budget. */
function RefundedCard(props: { task: TaskView; verifiedFail: boolean }) {
  const { task } = props;
  const secs = secondsBetween(task.stepAt[0], task.stepAt[4]);
  return (
    <Alert
      variant="info"
      role="status"
      className="p-4 has-[>svg]:grid-cols-[calc(var(--spacing)*6)_1fr]"
    >
      <RotateCcw aria-hidden className="size-6!" />
      <AlertTitle className="line-clamp-none text-xl font-bold">
        Refunded {task.amount ?? "—"} tUSD to you
        {props.verifiedFail ? " · verified FAIL" : ""}
        {secs !== null ? ` · ${secs} s` : ""}
      </AlertTitle>
    </Alert>
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
            <p className="text-base text-muted-foreground">{PAYMENT_CAPTIONS[last]}</p>
          )}
        </>
      ) : (
        <p className="text-base text-muted-foreground">No escrow payment has been reported yet.</p>
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
