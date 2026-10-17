import { useEffect, useMemo, useState } from "react";
import { HELD_CAPTION, STOPPED_CAPTION, TASK_CAPTIONS } from "../lib/captions.js";
import { currentMachines } from "../lib/machines.js";
import { ringWithMining } from "../lib/mine.js";
import { useChain } from "../lib/queries.js";
import { FLOW, flowFor } from "../lib/steps.js";
import { isStreaming, isWorkerStopped, useNow } from "../lib/stopped.js";
import { railRows, stepViews, taskLabel } from "../lib/view.js";
import type { AppState } from "../store.js";
import { BlockedScene } from "./BlockedScene.js";
import { StageStepper } from "./StageStepper.js";
import { SettlePanel, VerifyPanel, WorkPanel } from "./StepPanels.js";
import type { Live } from "./WorkerLane.js";

/** Seconds the payment may stay held after a FAIL verdict before the block ring (a missing cancel) is shown. */
export const HELD_AFTER_FAIL_MS = 10_000;
/** FAIL verdict held more than 10 s with no cancel. The stopped-worker case is `isWorkerStopped` (lib/stopped.ts). */
export const isHeld = (task: { state: string; failAt?: string }, now: number): boolean =>
  task.state === "VERDICT_WITHHOLD" &&
  task.failAt !== undefined &&
  now - Date.parse(task.failAt) > HELD_AFTER_FAIL_MS;

export function Stage(props: {
  state: AppState;
  live: Live | null;
  descriptions?: Record<string, string>;
}) {
  const { state } = props;
  const key = state.selected;
  const block = key?.startsWith("block:")
    ? state.blocks.find((b) => `block:${b.seq}` === key)
    : null;
  const task = key && !block ? state.tasks[key] : undefined;
  const sel = state.selectedMandate ? state.mandates.get(state.selectedMandate) : undefined;
  const readOnly = sel !== undefined && sel.status === "retired";
  if (block)
    return (
      <BlockedScene
        block={block}
        names={state.payeeNames}
        remaining={state.budget?.remaining ?? null}
      />
    );
  if (!key || !task)
    return (
      <p className="text-xl text-muted-foreground">
        {!state.root
          ? "Create a mandate first."
          : readOnly
            ? "This mandate is retired. Its tasks stay listed on the left; nothing new can start under it."
            : "Pick a task on the left, or start a new one. Each step of its journey shows up here."}
      </p>
    );
  return (
    <TaskStage state={state} id={key} live={props.live} descriptions={props.descriptions ?? {}} />
  );
}

function TaskStage(props: {
  state: AppState;
  id: string;
  live: Live | null;
  descriptions: Record<string, string>;
}) {
  const { state, id } = props;
  const task = state.tasks[id];
  const pos = task ? flowFor(task.state) : null;
  const waiting = task?.state === "VERDICT_WITHHOLD" || task?.state === "ESCROW_LOCKED";
  const now = useNow(waiting);
  const stopped = task ? isWorkerStopped(task, now, isStreaming(props.live, id)) : false;
  // A stopped worker leaves Settle as the only live step: money waits there for the refund.
  const activeIdx = stopped ? 4 : pos ? Math.min(pos.active, FLOW.length - 1) : 0;
  const [viewed, setViewed] = useState<number | null>(null);
  // Following the task again whenever the task or its active step changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: both are reset triggers
  useEffect(() => setViewed(null), [id, activeIdx]);
  const last = task?.payHistory[task.payHistory.length - 1]?.status;
  const locked = last === "Pending" || last === "Claimable";
  const machines = useMemo(currentMachines, []);
  const chain = ringWithMining(useChain(id, locked), state.mine[id]);
  if (!task || !pos) return null;
  const held = isHeld(task, now) || stopped;
  const shown = viewed ?? activeIdx;
  const steps = stepViews(task, machines, stopped);
  const n = railRows(state).find((r) => r.key === id)?.n;
  const worker = (state.root && state.payeeNames[state.root.allowed_payees[0] ?? ""]) || "worker";
  const verdict = [...state.verdicts].reverse().find((v) => v.task_id === id) ?? null;
  const liveHere = props.live?.key.startsWith(`${id}:`) ? props.live : null;
  return (
    <div className="grid gap-4 [.presenter_&]:gap-2">
      <header className="grid gap-1">
        <p className="text-base text-muted-foreground">Task #{n}</p>
        <h2 className="text-xl font-semibold">{taskLabel(id, props.descriptions)}</h2>
        <p className="text-base text-muted-foreground">
          {task.amount && <span className="tabular-nums text-foreground">{task.amount} tUSD </span>}
          to {worker}
        </p>
      </header>
      <StageStepper steps={steps} shown={shown} onShow={setViewed} />
      <section
        aria-label={`Step ${shown + 1}: ${steps[shown]?.label}`}
        className="grid gap-4 [.presenter_&]:gap-2"
      >
        <p aria-live="polite" className={task.state === "CLAIMED" ? "sr-only" : "text-xl"}>
          {stopped ? STOPPED_CAPTION : held ? HELD_CAPTION : TASK_CAPTIONS[task.state]}
        </p>
        <div key={shown}>
          {shown === 2 && <WorkPanel live={liveHere} attempt={task.attempt} stopped={stopped} />}
          {shown === 3 && <VerifyPanel taskId={id} verdict={verdict} skipped={stopped} />}
          {shown === 4 && (
            <SettlePanel
              taskId={id}
              task={task}
              chain={chain}
              worker={worker}
              verifiedPass={verdict?.verdict === "RELEASE"}
              verifiedFail={verdict?.verdict === "WITHHOLD"}
              held={held}
            />
          )}
          {shown < 2 && (
            <p className="text-base text-muted-foreground">
              {steps[shown]?.machine}: this step is handled automatically.
            </p>
          )}
        </div>
      </section>
    </div>
  );
}
