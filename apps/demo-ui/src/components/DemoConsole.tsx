import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pickaxe, ShieldAlert, Wrench, X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { ApiError, mineUntilRefund } from "../lib/api.js";
import { mineErrorText } from "../lib/mine.js";
import { isMock } from "../lib/mode.js";
import { useAttack } from "../lib/queries.js";
import { fetchWorkerConfig, setWorkerConfig, type WorkerConfig } from "../lib/workerApi.js";
import { type AppState, useStore } from "../store.js";

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
    onError: () => toast.error("The worker did not accept the change."),
  });
  return {
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
      <h3 className="flex items-center gap-2 text-base font-semibold">
        <Wrench aria-hidden className="size-4" /> Worker switches
      </h3>
      {w.unreachable && (
        <p role="alert" className="text-sm font-semibold">
          Worker not reachable: the switches below are not its real state.
        </p>
      )}
      {rows.map((r) => {
        const on = w.config?.[r.key] === true;
        return (
          <div key={r.key} className="flex items-start gap-3">
            <Switch
              id={`sw-${r.key}`}
              checked={on}
              disabled={!w.config || w.busy}
              onCheckedChange={(v) => w.set({ [r.key]: v })}
            />
            <div className="grid gap-0.5">
              <Label htmlFor={`sw-${r.key}`} className="text-base">
                {r.label}: {w.config ? (on ? "on" : "off") : "unknown"}
              </Label>
              <p className="text-sm text-muted-foreground">{r.help}</p>
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
  return (
    <section
      aria-label="Compromised agent"
      className="grid content-start gap-2"
      title="The real buyer agent tries to pay someone not allowed. The engine must refuse."
    >
      <h3 className="flex items-center gap-2 text-base font-semibold">
        <ShieldAlert aria-hidden className="size-4" /> Compromised agent
      </h3>
      <Button
        type="button"
        variant="outline"
        disabled={mock || attack.isPending}
        onClick={() =>
          attack.mutate(undefined, {
            onSuccess: (r) => toast(r.message),
            onError: (e) =>
              toast.error(e instanceof ApiError ? e.message : "The simulation could not run."),
          })
        }
      >
        {attack.isPending ? "Sending..." : "Simulate compromised agent"}
      </Button>
      {mock && <p className="text-sm text-muted-foreground">Live only.</p>}
    </section>
  );
}

const isTask = (s: AppState): string | null =>
  s.selected && !s.selected.startsWith("block:") && s.tasks[s.selected] ? s.selected : null;

function Mine() {
  const taskId = useStore(isTask);
  const progress = useStore((s) => (taskId ? s.mine[taskId] : undefined));
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
      <h3 className="flex items-center gap-2 text-base font-semibold">
        <Pickaxe aria-hidden className="size-4" /> Mine until refund
      </h3>
      <Button
        type="button"
        disabled={!taskId || run.isPending || mining}
        onClick={() => taskId && run.mutate(taskId)}
      >
        {mining ? "Mining..." : "Mine until refund"}
      </Button>
      {!taskId && <p className="text-sm text-muted-foreground">Select a task in the list first.</p>}
      <div aria-live="polite" className="grid gap-1 text-sm">
        {error && (
          <p role="alert" className="font-semibold">
            {error}
          </p>
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

/** Bottom drawer with the live demo controls. Only rendered when the engine enables the demo switches. */
export function DemoConsole(props: { open: boolean; onClose: () => void }) {
  if (!props.open) return null;
  return (
    <aside aria-label="Demo console" className="shrink-0 border-t-2 bg-card px-8 py-3">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="font-display text-lg font-bold">Demo console</h2>
        <Button type="button" variant="ghost" size="sm" onClick={props.onClose}>
          <X aria-hidden /> Close
        </Button>
      </div>
      <div className="grid grid-cols-3 gap-8">
        <Switches />
        <Attack />
        <Mine />
      </div>
    </aside>
  );
}
