import type { BlockCode } from "@verdict/protocol";
import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { WordButton } from "@/components/ui/word-button";
import {
  acceptedIntent,
  baseName,
  byteLength,
  downloadText,
  intentFacts,
  lineCount,
  SELF_CHECK_WORD,
  togglesWord,
} from "../lib/agents.js";
import {
  type AgentsData,
  type DeliveryFile,
  loadingRemote,
  useAgentsData,
} from "../lib/agentsData.js";
import { BLOCK_TITLES } from "../lib/blocks.js";
import { buyerFacts } from "../lib/buyerApi.js";
import { eventsFor } from "../lib/events.js";
import { workLog } from "../lib/workLog.js";
import { type AppState, useStore } from "../store.js";
import { Hash, middle } from "./Hash.js";

const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour12: false });
const NOT_YET = "not reported yet";

function Missing(props: { children?: string }) {
  return <span className="text-subtle">{props.children ?? NOT_YET}</span>;
}

/** One ledger row: uppercase label, value. A null value reads "not reported yet" in muted text. */
function Row(props: { label: string; children?: React.ReactNode; mono?: boolean }) {
  const has = props.children !== undefined && props.children !== null && props.children !== false;
  return (
    <div className="grid grid-cols-[13rem_1fr] gap-x-4 border-t border-rule-soft py-1.5 first:border-t-0">
      <dt className="text-sm font-semibold uppercase tracking-wide">{props.label}</dt>
      <dd className={`min-w-0 break-words text-base ${props.mono ? "font-mono" : ""}`}>
        {has ? props.children : <Missing />}
      </dd>
    </div>
  );
}

function Section(props: { id: string; title: string; caption: string; children: React.ReactNode }) {
  return (
    <section aria-labelledby={props.id} className="grid gap-1 border-t-2 border-ink pt-3">
      <h3 id={props.id} className="text-xl font-semibold uppercase tracking-wide">
        {props.title}
      </h3>
      <p className="pb-1 text-base text-subtle">{props.caption}</p>
      {props.children}
    </section>
  );
}

function CopyWord(props: { text: string; label: string }) {
  const [st, setSt] = useState<"idle" | "copied" | "failed">("idle");
  return (
    <WordButton
      aria-label={`Copy ${props.label}`}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(props.text);
          setSt("copied");
          setTimeout(() => setSt("idle"), 1500);
        } catch {
          setSt("failed");
        }
      }}
    >
      <span aria-live="polite">
        {st === "copied" ? "Copied" : st === "failed" ? "Copy unavailable" : "Copy"}
      </span>
    </WordButton>
  );
}

/** A delivered file, shown as text only (never executed or rendered as HTML). */
function DeliveryBlock(props: { file: DeliveryFile }) {
  const { file } = props;
  return (
    <div className="grid gap-1">
      <div className="flex flex-wrap items-baseline gap-x-4">
        <span className="font-mono text-sm font-semibold">{file.path}</span>
        <span className="font-mono text-sm text-subtle">
          {byteLength(file.content)} bytes · {lineCount(file.content)} lines
        </span>
        <CopyWord text={file.content} label={file.path} />
        <WordButton
          aria-label={`Download ${baseName(file.path)}`}
          onClick={() => downloadText(file.path, file.content)}
        >
          Download
        </WordButton>
      </div>
      <pre className="max-h-72 overflow-auto border border-rule p-3 font-mono text-sm whitespace-pre-wrap">
        {file.content}
      </pre>
    </div>
  );
}

type Sel = { kind: "none" } | { kind: "task"; id: string } | { kind: "block"; seq: number };

function selection(s: AppState): Sel {
  const k = s.selected;
  if (!k) return { kind: "none" };
  if (k.startsWith("block:")) {
    const seq = Number(k.slice(6));
    return s.blocks.some((b) => b.seq === seq) ? { kind: "block", seq } : { kind: "none" };
  }
  return s.tasks[k] ? { kind: "task", id: k } : { kind: "none" };
}

/** Payee as the mandate names it: the worker's name plus a short id, or the short id alone. */
function payee(id: string, names: Record<string, string>): string {
  const short = middle(id, 12, 6);
  return names[id] ? `${names[id]} · ${short}` : short;
}

function Buyer(props: {
  s: AppState;
  sel: Sel;
  data: AgentsData;
  descriptions: Record<string, string>;
}) {
  const { s, sel, data } = props;
  const root = s.root;
  const evidence = data.evidence.status === "ready" ? data.evidence.data : null;
  const block = sel.kind === "block" ? s.blocks.find((b) => b.seq === sel.seq) : undefined;
  const facts = block ? intentFacts(block.intent) : null;
  const accepted = sel.kind === "task" ? acceptedIntent(evidence?.intent) : null;
  const intent = facts ?? accepted;
  const buyer = buyerFacts(
    data.buyer.status === "ready" ? data.buyer.data : [],
    evidence?.intent_sha256 ?? null,
  );
  const task = sel.kind === "task" ? s.tasks[sel.id] : undefined;
  return (
    <Section
      id="agents-buyer"
      title="Buyer"
      caption="The buyer agent turns your goal into one payment request. The engine, which holds your rules, answers yes or no."
    >
      {data.buyer.status === "unreachable" && (
        <p role="status" className="text-base font-semibold">
          Buyer agent not reachable. Only what the engine reported is shown.
        </p>
      )}
      <dl>
        <Row label="Goal for the mandate">{buyer.mandateGoal}</Row>
        <Row label="Signed mandate">
          {root && (
            <span className="font-mono">
              {root.cap_id} · at most {root.max_total} tUSD · {root.max_per_task ?? "—"} per task
            </span>
          )}
        </Row>
        <Row label="Task goal">
          {sel.kind === "task" ? props.descriptions[sel.id] : block ? facts?.task_spec : undefined}
        </Row>
        <Row label="Amount" mono>
          {intent?.amount ? `${intent.amount} tUSD` : undefined}
        </Row>
        <Row label="Payee">
          {intent?.counterparty ? (
            <span className="font-mono">{payee(intent.counterparty, s.payeeNames)}</span>
          ) : undefined}
        </Row>
        <Row label="Category" mono>
          {intent?.category}
        </Row>
        <Row label="Deadline" mono>
          {intent?.deadline}
        </Row>
        <Row label="The agent's reason">{intent?.rationale}</Row>
        <Row label="Model reasoning">
          {buyer.thinking ? (
            <>
              <span className="block text-sm text-subtle">
                Model reasoning (shown after the call)
              </span>
              <span className="block whitespace-pre-wrap">{buyer.thinking}</span>
            </>
          ) : undefined}
        </Row>
        <Row label="Engine answer">
          {block ? (
            <span className="block">
              <span className="font-semibold uppercase">
                Blocked · <span className="font-mono normal-case">{block.code}</span>
              </span>
              <span className="block">{block.message}</span>
              <span className="block text-sm text-subtle">
                {BLOCK_TITLES[block.code as BlockCode]}
              </span>
            </span>
          ) : task ? (
            <span className="font-semibold uppercase">
              Accepted · task{" "}
              <span className="font-mono normal-case">{sel.kind === "task" ? sel.id : ""}</span>
            </span>
          ) : undefined}
        </Row>
        {sel.kind === "task" && (
          <Row label="Buyer's own record">
            {buyer.decision && buyer.decisionAt ? (
              <span>
                <span className="font-semibold uppercase">{buyer.decision.status}</span>{" "}
                <span className="font-mono">{time(buyer.decisionAt)}</span>{" "}
                <span className="text-subtle">(clock of the buyer service)</span>
              </span>
            ) : undefined}
          </Row>
        )}
      </dl>
    </Section>
  );
}

function Worker(props: { sel: Sel; data: AgentsData; s: AppState }) {
  const { sel, data } = props;
  const caption =
    "The worker agent, a local AI model, does the job. It checks its own work and may try again before handing in a file.";
  if (sel.kind !== "task")
    return (
      <Section id="agents-worker" title="Worker" caption={caption}>
        <p className="text-base font-semibold">Not started. The request was blocked first.</p>
      </Section>
    );
  const w = data.worker;
  const task = w.status === "ready" ? w.data : null;
  const maxAttempts = task?.progress?.max_attempts ?? 3;
  const evidenceFiles =
    data.evidence.status === "ready" ? (data.evidence.data?.delivery?.files ?? null) : null;
  const files = evidenceFiles ?? (data.delivery.status === "ready" ? data.delivery.data : null);
  return (
    <Section id="agents-worker" title="Worker" caption={caption}>
      {w.status === "unreachable" && (
        <p role="status" className="text-base font-semibold">
          Worker not reachable. Worker stopped responding or is off.
        </p>
      )}
      {w.status === "loading" && (
        <p className="text-base text-subtle">Loading the worker's record.</p>
      )}
      <dl>
        <Row label="Started with">{task ? togglesWord(task.toggles) : undefined}</Row>
      </dl>
      {task && (task.attempts?.length ?? 0) === 0 && (
        <p className="text-base text-subtle">No attempt recorded yet.</p>
      )}
      <ol className="grid">
        {task?.attempts?.map((a) => (
          <li
            key={a.n}
            className="grid grid-cols-[13rem_1fr] gap-x-4 border-t border-rule-soft py-1.5 text-base"
          >
            <span className="text-sm font-semibold uppercase tracking-wide">
              Attempt {a.n}/{maxAttempts}
            </span>
            <span>
              own check{" "}
              <span className="font-semibold uppercase">
                {SELF_CHECK_WORD[a.self_check] ?? "not checked"}
              </span>
              {" · "}
              <span className="font-mono">{a.seconds.toFixed(1)} s</span>
              {" · "}
              <span className="font-mono">
                {a.tokens_per_sec === null ? "— tok/s" : `${a.tokens_per_sec.toFixed(1)} tok/s`}
              </span>
            </span>
          </li>
        ))}
      </ol>
      <h4 className="mt-2 text-sm font-semibold uppercase tracking-wide">Delivered file</h4>
      {files && files.length > 0 ? (
        files.map((f) => <DeliveryBlock key={f.path} file={f} />)
      ) : (
        <p className="text-base text-subtle">
          {w.status === "unreachable" ? "Worker stopped responding." : "Not delivered."}
        </p>
      )}
    </Section>
  );
}

function Verifier(props: { sel: Sel; data: AgentsData; s: AppState }) {
  const { sel, data, s } = props;
  const caption =
    "The verifier, on a separate machine, runs a fixed test on the file. No AI decides. It signs PASS or FAIL.";
  if (sel.kind !== "task")
    return (
      <Section id="agents-verifier" title="Verifier" caption={caption}>
        <p className="text-base font-semibold">Not started. The request was blocked first.</p>
      </Section>
    );
  const v = data.verifier;
  const task = v.status === "ready" ? v.data : null;
  const report = task?.reports[task.reports.length - 1];
  const stored = [...s.verdicts].reverse().find((x) => x.task_id === sel.id);
  const record = report?.record ?? stored;
  return (
    <Section id="agents-verifier" title="Verifier" caption={caption}>
      {v.status === "unreachable" && (
        <p role="status" className="text-base font-semibold">
          Verifier not reachable. The signed verdict below is what the engine received.
        </p>
      )}
      {!record ? (
        <p className="text-base text-subtle">Not run.</p>
      ) : (
        <dl aria-live="polite">
          <Row label="Result">
            <span className="font-semibold uppercase">
              {record.verdict === "RELEASE" ? "PASS" : "FAIL"}
            </span>{" "}
            · attempt <span className="font-mono">{record.attempt}</span> · exit code{" "}
            <span className="font-mono">{record.exit_code}</span>
          </Row>
          <Row label="Checks">
            {record.checks.length === 0 ? (
              "none ran"
            ) : (
              <ul className="font-mono text-sm">
                {record.checks.map((c) => (
                  <li key={c.id}>
                    <span aria-hidden>{c.status === "PASS" ? "■" : "×"} </span>
                    {c.id}: {c.status}
                  </li>
                ))}
              </ul>
            )}
          </Row>
          <Row label="Sandbox">
            {report ? (
              <span>
                {report.sandbox} · no network ·{" "}
                <span className="font-mono">{report.seconds} s</span>
              </span>
            ) : undefined}
          </Row>
          <Row label="Test package">
            <Hash value={record.verifier_package_sha256} label="package hash" />
          </Row>
          <Row label="Signed verdict">
            <span>
              <span className="font-semibold uppercase">{record.verdict}</span>{" "}
              <Hash value={record.verifier_sig} label="verdict signature" />
            </span>
          </Row>
          <Row label="Log tail">
            {report ? (
              <pre className="max-h-32 overflow-auto border border-rule p-2 font-mono text-sm">
                {report.log_tail.join("\n")}
              </pre>
            ) : undefined}
          </Row>
        </dl>
      )}
    </Section>
  );
}

function WorkLog(props: { s: AppState }) {
  const rows = workLog(eventsFor(props.s));
  return (
    <Section
      id="agents-log"
      title="Work log"
      caption="Everything that happened to this request, in order, in plain words."
    >
      <ol aria-live="polite" className="grid">
        {rows.length === 0 && <li className="text-base text-subtle">Nothing has happened yet.</li>}
        {rows.map((r) => (
          <li
            key={r.key}
            className="grid grid-cols-[6rem_6.5rem_1fr] gap-x-4 border-t border-rule-soft py-1 text-base first:border-t-0"
          >
            <span className="font-mono text-sm">{time(r.at)}</span>
            <span className="text-sm font-semibold uppercase tracking-wide">{r.agent}</span>
            <span>{r.text}</span>
          </li>
        ))}
      </ol>
    </Section>
  );
}

/** The four sections for the selected rail row. Pure: data comes in as props. */
export function AgentsBody(props: {
  state: AppState;
  data: AgentsData;
  descriptions?: Record<string, string>;
}) {
  const sel = selection(props.state);
  if (sel.kind === "none")
    return (
      <p className="border-t-2 border-ink pt-3 text-base">
        Select a task to see what each agent did.
      </p>
    );
  return (
    <div className="grid gap-6">
      <Buyer s={props.state} sel={sel} data={props.data} descriptions={props.descriptions ?? {}} />
      <Worker s={props.state} sel={sel} data={props.data} />
      <Verifier s={props.state} sel={sel} data={props.data} />
      <WorkLog s={props.state} />
    </div>
  );
}

export const EMPTY_AGENTS_DATA: AgentsData = {
  worker: loadingRemote,
  verifier: loadingRemote,
  evidence: loadingRemote,
  delivery: loadingRemote,
  buyer: loadingRemote,
};

/** Full-width panel opened by the word AGENTS or the key `a` (which also closes it). Read-only. */
export function AgentsPanel(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mock: boolean;
  descriptions: Record<string, string>;
}) {
  const state = useStore();
  const { open, onOpenChange } = props;
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target;
      const typing =
        t instanceof HTMLElement &&
        (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
      if (e.key === "a" && !e.ctrlKey && !e.metaKey && !e.altKey && !typing) onOpenChange(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onOpenChange]);
  const sel = selection(state);
  const taskId = sel.kind === "task" ? sel.id : null;
  const data = useAgentsData(
    taskId,
    taskId ? (state.tasks[taskId]?.state ?? null) : null,
    props.mock,
    open,
  );
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl">
        <DialogHeader>
          <DialogTitle>Agents</DialogTitle>
          <DialogDescription>
            What the buyer, the worker and the verifier each decided and produced for the selected
            request. Read only.
          </DialogDescription>
        </DialogHeader>
        <AgentsBody state={state} data={data} descriptions={props.descriptions} />
      </DialogContent>
    </Dialog>
  );
}
