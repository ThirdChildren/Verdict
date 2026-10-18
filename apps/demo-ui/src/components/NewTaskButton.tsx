import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ApiError } from "../lib/api.js";
import { readOnlyReason } from "../lib/mandates.js";
import { fromMinor, toMinor } from "../lib/money.js";
import { useStartTask } from "../lib/queries.js";
import {
  AMOUNT_STEP,
  amountProblem,
  composeTaskGoal,
  DEFAULT_TASK_DESCRIPTION,
  defaultTaskAmount,
} from "../lib/taskText.js";
import { useStore } from "../store.js";
import { Mark } from "./Mark.js";

/** Why a new task cannot start, or null when it can. */
export function newTaskBlocker(
  hasRoot: boolean,
  remaining: string | null,
  precision: number,
  readOnly: string | null = null,
): string | null {
  if (!hasRoot) return "Sign a mandate first. A new task needs an active mandate.";
  if (readOnly) return readOnly;
  if (remaining !== null && toMinor(remaining, precision) === 0n)
    return `The mandate budget is used up (${fromMinor(0n, precision)} tUSD remaining). Sign a new mandate to continue.`;
  return null;
}

/** Name to put in the task text: the worker named in the signed mandate, else the planner's default "worker". */
export function workerNameFor(payees: string[], names: Record<string, string>): string {
  const first = payees[0];
  return (first ? names[first] : undefined) ?? "worker";
}

/** Form schema; the amount ceiling is whatever the engine last reported as remaining. */
export function taskFormSchema(remaining: string, precision: number) {
  return z.object({
    description: z.string().trim().min(3, "Describe the work in at least 3 characters.").max(300),
    amount: z.string().superRefine((v, ctx) => {
      const p = amountProblem(v, remaining, precision);
      if (p) ctx.addIssue({ code: "custom", message: p });
    }),
  });
}
type TaskForm = z.infer<ReturnType<typeof taskFormSchema>>;

/** "New task" button and its dialog. `openSignal` lets a keyboard shortcut open it. */
export function NewTaskButton({ openSignal = 0 }: { openSignal?: number }) {
  const id = useId();
  const root = useStore((s) => s.root);
  const budget = useStore((s) => s.budget);
  const precision = useStore((s) => s.precision);
  const names = useStore((s) => s.payeeNames);
  const [open, setOpen] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  // The engine-reported remaining of the mandate is the ceiling for one task, never the task amount.
  const remaining = budget?.remaining ?? root?.max_total ?? "0";
  const readOnly = useStore((s) =>
    readOnlyReason(s.selectedMandate ? s.mandates.get(s.selectedMandate) : undefined, Date.now()),
  );
  const blocker = newTaskBlocker(root !== null, budget?.remaining ?? null, precision, readOnly);
  const schema = useMemo(() => taskFormSchema(remaining, precision), [remaining, precision]);
  const form = useForm<TaskForm>({
    resolver: zodResolver(schema),
    defaultValues: {
      description: DEFAULT_TASK_DESCRIPTION,
      amount: defaultTaskAmount(remaining, precision),
    },
  });
  const worker = workerNameFor(root?.allowed_payees ?? [], names);
  const start = useStartTask();
  const { reset } = form;

  // Only a signal that changes while this button is mounted opens the dialog: a key pressed earlier is stale.
  const seenSignal = useRef(openSignal);
  // biome-ignore lint/correctness/useExhaustiveDependencies: only a changed signal opens the dialog
  useEffect(() => {
    if (openSignal === seenSignal.current) return;
    seenSignal.current = openSignal;
    if (!blocker) setOpen(true);
  }, [openSignal]);
  // Each time the dialog opens, start from the defaults for what is left.
  useEffect(() => {
    if (open) {
      setFailure(null);
      reset({
        description: DEFAULT_TASK_DESCRIPTION,
        amount: defaultTaskAmount(remaining, precision),
      });
    }
  }, [open, remaining, precision, reset]);

  const submit = form.handleSubmit(async (v) => {
    try {
      await start.mutateAsync({
        amount: v.amount,
        goal: composeTaskGoal(v.amount, worker, v.description),
      });
      setSent(`Task sent: ${v.amount} tUSD to ${worker}.`);
      setOpen(false);
    } catch (err) {
      setFailure(err instanceof ApiError ? err.message : "Something went wrong.");
    }
  });
  const amount = form.watch("amount");
  const description = form.watch("description");
  const errors = form.formState.errors;
  return (
    <section aria-label="New task">
      <Button
        type="button"
        variant={blocker === null ? "default" : "outline"}
        className="w-full uppercase"
        onClick={() => setOpen(true)}
        disabled={blocker !== null}
        aria-describedby={`${id}-why`}
        title="Start a new task (n)"
      >
        New task
      </Button>
      <p id={`${id}-why`} aria-live="polite" className="mt-2 text-sm text-subtle">
        {blocker ?? "No new signature needed."}
      </p>
      {sent && (
        <p role="status" className="mt-1 text-sm font-semibold">
          <Mark kind="done" className="mr-1" />
          {sent}
        </p>
      )}
      <Dialog
        open={open && !blocker}
        onOpenChange={(o) => {
          setOpen(o);
          if (o) setSent(null);
        }}
      >
        <DialogContent>
          <form onSubmit={submit} className="grid gap-4" noValidate>
            <DialogHeader>
              <DialogTitle className="text-xl">New task</DialogTitle>
              <DialogDescription>
                The agent gets a narrower permission just for this task. No new signature needed.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-2">
              <Label htmlFor={`${id}-d`} className="text-lg font-semibold">
                What should the worker do?
              </Label>
              <Input
                id={`${id}-d`}
                maxLength={300}
                aria-invalid={errors.description !== undefined}
                {...form.register("description")}
              />
              {errors.description && (
                <p role="alert" className="font-semibold">
                  {errors.description.message}
                </p>
              )}
              <p className="text-base text-subtle">
                Today the worker can only convert CSV files to JSON; any other job fails the test
                and is refunded.
              </p>
            </div>
            <div className="grid gap-2">
              <Label htmlFor={`${id}-a`} className="text-lg font-semibold">
                Amount for this task (tUSD, up to {remaining} left in the mandate)
              </Label>
              <Input
                id={`${id}-a`}
                type="number"
                inputMode="decimal"
                step={AMOUNT_STEP}
                min={AMOUNT_STEP}
                className="w-40"
                aria-invalid={errors.amount !== undefined}
                {...form.register("amount")}
              />
              {errors.amount && (
                <p role="alert" className="font-semibold">
                  {errors.amount.message}
                </p>
              )}
            </div>
            <p className="text-base text-subtle">
              The agent will be told: "{composeTaskGoal(amount, worker, description)}"
            </p>
            {failure && (
              <p
                role="alert"
                className=" border border-rule-soft border-l-4 border-l-bad bg-card px-4 py-2 font-semibold"
              >
                {failure}
              </p>
            )}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={start.isPending}>
                {start.isPending ? "Sending..." : "Start task"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </section>
  );
}
