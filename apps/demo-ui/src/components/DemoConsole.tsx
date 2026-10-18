import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { WordButton } from "@/components/ui/word-button";
import { ApiError, mineUntilRefund } from "../lib/api.js";
import { mineErrorText } from "../lib/mine.js";
import { isMock } from "../lib/mode.js";
import { useAttack } from "../lib/queries.js";
import { fetchWorkerConfig, setWorkerConfig, type WorkerConfig } from "../lib/workerApi.js";
import { type AppState, useStore } from "../store.js";
import { Mark } from "./Mark.js";

/** The switches as the worker really has them (polled). In ?mock=1 they are local and canned. */
function useWorkerSwitches() {
  const qc = useQueryClient();
  const mock = isMock();
  const [canned, setCanned] = useState<WorkerConfig>({ sabotaged: false, disappears: false });
  const q = useQuery<WorkerConfig>({
    queryKey: ["worker-config"],
    queryFn: fetchWorkerConfig,
    enabled: !mock,
    refetchInterval: 2000,
    retry: false,
  });
  const change = useMutation({
    mutationFn: async (c: Partial<WorkerConfig>) => {
      if (mock) {
        const next = { ...canned, ...c };
        setCanned(next);
        return next;
      }
      return setWorkerConfig(c);
    },
    onSuccess: (cfg) => qc.setQueryData(["worker-config"], cfg),
  });
  return {
    failed: change.isError,
    config: mock ? canned : (q.data ?? null),
    unreachable: !mock && q.isError,
    set: (c: Partial<WorkerConfig>) => change.mutate(c),
    busy: change.isPending,
  };
}

function Switches() {
  const w = useWorkerSwitches();
  const rows: { key: keyof WorkerConfig; label: string; help: string }[] = [
    {
      key: "sabotaged",
      label: "Sabotaged",
      help: "Broken file: FAIL, funds return.",
    },
    {
      key: "disappears",
      label: "Disappears",
      help: "Never claims: funds stay locked.",
    },
  ];
  return (
    <section aria-label="Worker switches" className="grid content-start gap-2">
      <h3 className="text-sm font-semibold uppercase">Worker switches</h3>
      {w.unreachable && (
        <p role="alert" className="text-sm font-semibold">
          Worker not reachable: the switches below are not its real state.
        </p>
      )}
      {w.failed && (
        <p role="alert" className="text-sm font-semibold">
          <Mark kind="attention" className="mr-1" />
          The worker did not accept the change.
        </p>
      )}
      {rows.map((r) => {
        const on = w.config?.[r.key] === true;
        return (
          <div key={r.key} className="flex items-center gap-3">
            <Switch
              id={`sw-${r.key}`}
              checked={on}
              disabled={!w.config || w.busy}
              onCheckedChange={(v) => w.set({ [r.key]: v })}
            />
            <div className="flex flex-wrap items-baseline gap-x-3">
              <Label htmlFor={`sw-${r.key}`} className="text-base">
                {r.label}: {w.config ? (on ? "on" : "off") : "unknown"}
              </Label>
              <p className="text-sm text-subtle">{r.help}</p>
            </div>
          </div>
        );
      })}
    </section>
  );
}

function Attack() {
  const attack = useAttack();
  const mock = isMock();
  const [result, setResult] = useState<{ text: string; bad: boolean } | null>(null);
  return (
    <section
      aria-label="Compromised agent"
      className="grid content-start gap-2"
      title="The real buyer agent tries to pay someone not allowed. The engine must refuse."
    >
      <h3 className="text-sm font-semibold uppercase">Compromised agent</h3>
      <Button
        type="button"
        variant="outline"
        disabled={mock || attack.isPending}
        onClick={() =>
          attack.mutate(undefined, {
            onSuccess: (r) => setResult({ text: r.message, bad: false }),
            onError: (e) =>
              setResult({
                text: e instanceof ApiError ? e.message : "The simulation could not run.",
                bad: true,
              }),
          })
        }
      >
        {attack.isPending ? "Sending..." : "Simulate compromised agent"}
      </Button>
      {mock && (
        <p className="text-sm text-subtle">
          Live only. In mock mode pick '11 · Blocked attempt' in the storyboard.
        </p>
      )}
      <div aria-live="polite" className="text-sm">
        {result && (
          <p role={result.bad ? "alert" : "status"} className="font-semibold">
            {result.text}
          </p>
        )}
      </div>
    </section>
  );
}

const isTask = (s: AppState): string | null =>
  s.selected && !s.selected.startsWith("block:") && s.tasks[s.selected] ? s.selected : null;

function Mine() {
  const taskId = useStore(isTask);
  const progress = useStore((s) => (taskId ? s.mine[taskId] : undefined));
  const taskState = useStore((s) => (taskId ? s.tasks[taskId]?.state : undefined));
  // Only funds that are still held can time out and return.
  const holding = taskState === "ESCROW_LOCKED" || taskState === "VERDICT_WITHHOLD";
  const [error, setError] = useState<string | null>(null);
  const run = useMutation({
    mutationFn: (id: string) => mineUntilRefund(id),
    onMutate: () => setError(null),
    onError: (e) =>
      setError(
        e instanceof ApiError
          ? mineErrorText(e.code, e.message)
          : "The engine could not be reached.",
      ),
  });
  const mining = progress?.state === "mining";
  return (
    <section
      aria-label="Mine until refund"
      className="grid content-start gap-2"
      title="Mines blocks until the selected task's locked funds time out and return."
    >
      <h3 className="text-sm font-semibold uppercase">Mine until refund</h3>
      <Button
        type="button"
        disabled={!taskId || !holding || run.isPending || mining}
        onClick={() => taskId && run.mutate(taskId)}
      >
        {mining ? "Mining..." : "Mine until refund"}
      </Button>
      {!taskId && <p className="text-sm text-subtle">Select a task in the list first.</p>}
      {taskId && !holding && (
        <p className="text-sm text-subtle">Only while the task's funds are still locked.</p>
      )}
      <div aria-live="polite" className="grid gap-1 text-sm">
        {error && (
          <p role="alert" className="font-semibold">
            {error}
          </p>
        )}
        {progress?.state === "mining" && (
          <div
            role="img"
            aria-label={`Mining ${progress.percent} percent`}
            className="h-1 w-full bg-rule-soft"
          >
            <div className="h-full bg-ink" style={{ width: `${progress.percent}%` }} />
          </div>
        )}
        {progress && (
          <p role="status">
            {progress.state === "mining" &&
              `Mining: block ${progress.height} of ${progress.target_height} (${progress.percent}%).`}
            {progress.state === "refunded" &&
              "Done: the payment failed back and the funds are released."}
            {progress.state === "gave_up" &&
              "Stopped: the payment did not expire within the block limit. Nothing was lost."}
          </p>
        )}
      </div>
    </section>
  );
}

/** Bottom panel with the live demo controls, ruled above. Only rendered when the engine enables the demo switches. */
export function DemoConsole(props: { open: boolean; onClose: () => void }) {
  if (!props.open) return null;
  return (
    <aside
      aria-label="Demo console"
      className="shrink-0  border-t border-rule-soft bg-card px-8 py-2 shadow-lift"
    >
      <div className="mb-1 flex items-center justify-between">
        <h2 className="text-lg font-semibold">Demo console</h2>
        <WordButton onClick={props.onClose}>
          Close <span aria-hidden>×</span>
        </WordButton>
      </div>
      <div className="grid grid-cols-3 divide-x divide-rule-soft [&>*]:px-6 [&>*:first-child]:pl-0">
        <Switches />
        <Attack />
        <Mine />
      </div>
    </aside>
  );
}
