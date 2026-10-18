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
import { ApiError, clipRaw, engineBase } from "../lib/api.js";
import { type Draft, hash8, rulesOf } from "../lib/authoring.js";
import { explainError } from "../lib/explain.js";
import { readOnlyReason } from "../lib/mandates.js";
import { fromMinor, toMinor } from "../lib/money.js";
import {
  useAuthorTest,
  useInstallTaskType,
  useRouteRequest,
  useStartTask,
  useTaskTypes,
} from "../lib/queries.js";
import {
  AMOUNT_STEP,
  amountProblem,
  composeTaskGoal,
  DEFAULT_TASK_DESCRIPTION,
  defaultTaskAmount,
} from "../lib/taskText.js";
import { isUnverifiable, type TaskType, verifierHost } from "../lib/taskTypes.js";
import { useStore } from "../store.js";
import { AcceptanceTest, type Edits } from "./AcceptanceTest.js";
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

/** Appends the reassurance unless the message already ends with it. */
export function withNothingInstalled(m: string): string {
  const t = m.trimEnd();
  return t.endsWith("Nothing was installed.") ? t : `${t} Nothing was installed.`;
}

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
  // A refusal ("this cannot be verified") is not a failure: nothing was sent, and the choices are listed.
  const [refusal, setRefusal] = useState<{
    message: string;
    types: TaskType[] | null;
    reason?: string | undefined;
  } | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  // CHECK disagreed with the selected type: information, not a refusal.
  const [disagree, setDisagree] = useState<{ reason: string } | null>(null);
  // The last routing answer, keyed by the text it was asked about; editing the text makes it stale.
  const [routed, setRouted] = useState<{ text: string; id: string | null } | null>(null);
  // The raw body of the last failed answer, for the operator.
  const [lastAnswer, setLastAnswer] = useState<string | null>(null);
  const noteAnswer = (err: unknown) =>
    setLastAnswer(err instanceof ApiError && err.detail.raw ? clipRaw(err.detail.raw) : null);
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
  const types = useTaskTypes(open);
  const route = useRouteRequest();
  const resetRoute = route.reset;
  const [mapped, setMapped] = useState<{ id: string; reason: string } | null>(null);
  const author = useAuthorTest();
  const install = useInstallTaskType();
  const addTaskType = useStore((s) => s.addTaskType);
  const addedTypes = useStore((s) => s.addedTypes);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [edits, setEdits] = useState<Edits | null>(null);
  const [authorError, setAuthorError] = useState<string | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);
  const [installed, setInstalled] = useState<{
    id: string;
    title: string;
    sha: string;
    hidden: number;
    rules: number;
  } | null>(null);
  // The engine's list, plus types installed here or announced by TASK_TYPE_ADDED that the list does not show yet.
  const fetched: TaskType[] = types.data?.types ?? [];
  const list: TaskType[] = [
    ...fetched,
    ...addedTypes
      .filter((a) => !fetched.some((t) => t.id === a.id))
      .map((a) => ({ id: a.id, title: a.title, description: "", format: 1 })),
  ];
  const customSha = (id: string): string | undefined =>
    addedTypes.find((a) => a.id === id)?.package_sha256 || undefined;
  // No default: nothing runs under a test the user did not choose or the buyer agent did not route.
  const selectedType = list.find((t) => t.id === chosen)?.id ?? null;
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
      setRefusal(null);
      setChosen(null);
      setMapped(null);
      setDisagree(null);
      setRouted(null);
      setDraft(null);
      setEdits(null);
      setAuthorError(null);
      setInstallError(null);
      setInstalled(null);
      setLastAnswer(null);
      resetRoute();
      reset({
        description: DEFAULT_TASK_DESCRIPTION,
        amount: defaultTaskAmount(remaining, precision),
      });
    }
  }, [open, remaining, precision, reset, resetRoute]);

  const check = async () => {
    setRefusal(null);
    setFailure(null);
    setMapped(null);
    setDisagree(null);
    setLastAnswer(null);
    try {
      const r = await route.mutateAsync(description.trim());
      setMapped({ id: r.package_id, reason: r.reason });
      setChosen(r.package_id);
      setRouted({ text: description.trim(), id: r.package_id });
    } catch (err) {
      noteAnswer(err);
      if (err instanceof ApiError && isUnverifiable(err.code)) {
        setRouted({ text: description.trim(), id: null });
        if (selectedType !== null) {
          // The user's selection stands; the disagreement is shown as information.
          setDisagree({ reason: err.detail.reason ?? "" });
        } else {
          setRefusal({
            message: err.message,
            types: err.taskTypes ?? null,
            reason: err.detail.reason,
          });
          // None matched and nothing is selected: WRITE A TEST is offered, never launched.
        }
      } else setFailure(explainError(err, "Something went wrong."));
    }
  };
  const writeTest = async () => {
    setAuthorError(null);
    setInstallError(null);
    setInstalled(null);
    setLastAnswer(null);
    try {
      const d = await author.mutateAsync(description.trim());
      setDraft(d);
      setEdits({ title: d.title, description: d.description, visible: d.visible });
    } catch (err) {
      setDraft(null);
      setEdits(null);
      noteAnswer(err);
      setAuthorError(explainError(err, "The acceptance test could not be written."));
    }
  };
  const installDraft = async () => {
    if (!draft || !edits) return;
    setInstallError(null);
    setLastAnswer(null);
    try {
      // Hidden cases travel inside the draft object; the screen never shows them.
      const r = await install.mutateAsync({ ...draft, ...edits });
      const title = r.title?.trim() || edits.title;
      addTaskType({ id: r.id, title, package_sha256: r.package_sha256 });
      setInstalled({
        id: r.id,
        title,
        sha: r.package_sha256,
        hidden: draft.hidden.length,
        rules: rulesOf(draft.assertions).length,
      });
      setChosen(r.id);
      setRouted(null);
      setDraft(null);
      setEdits(null);
      setRefusal(null);
    } catch (err) {
      noteAnswer(err);
      setInstallError(explainError(err, "The test could not be installed."));
    }
  };
  const submit = form.handleSubmit(async (v) => {
    try {
      setFailure(null);
      setRefusal(null);
      setLastAnswer(null);
      await start.mutateAsync({
        ...(selectedType === null ? {} : { packageId: selectedType }),
        amount: v.amount,
        request: v.description.trim(),
        goal: composeTaskGoal(v.amount, worker, v.description),
      });
      setSent(`Task sent: ${v.amount} tUSD to ${worker}.`);
      setOpen(false);
    } catch (err) {
      noteAnswer(err);
      if (err instanceof ApiError && isUnverifiable(err.code))
        setRefusal({
          message: err.message,
          types: err.taskTypes ?? null,
          reason: err.detail.reason,
        });
      else setFailure(explainError(err, "Something went wrong."));
    }
  });
  const amount = form.watch("amount");
  const description = form.watch("description");
  const errors = form.formState.errors;
  const selectedTitle = list.find((t) => t.id === selectedType)?.title ?? "";
  const overridden =
    selectedType !== null &&
    routed !== null &&
    routed.text === description.trim() &&
    routed.id !== selectedType;
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
            <fieldset className="grid gap-2" aria-describedby={`${id}-tt`}>
              <legend className="text-lg font-semibold">Task type</legend>
              {types.isPending ? (
                <p role="status">Loading the task types the verifier can check...</p>
              ) : types.isError ? (
                <p role="alert" className="font-semibold">
                  Cannot reach the engine at {engineBase()}. Is it running?
                </p>
              ) : list.length === 0 ? (
                <p role="alert" className="font-semibold">
                  The engine offers no task type. Its package catalogue is empty: check
                  VERIFIER_PACKAGES_ROOT on the engine.
                </p>
              ) : (
                <ul className="divide-y divide-rule-soft border-y border-rule-soft">
                  {list.map((t) => (
                    <li key={t.id}>
                      <label className="grid cursor-pointer grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-3 py-2">
                        <input
                          type="radio"
                          name={`${id}-type`}
                          value={t.id}
                          checked={selectedType === t.id}
                          onChange={() => setChosen(t.id)}
                        />
                        <span>
                          <span className="text-base font-semibold">{t.title}</span>{" "}
                          <span className="font-mono text-sm uppercase text-subtle">{t.id}</span>
                          {customSha(t.id) && (
                            <span className="font-mono text-sm text-subtle">
                              {" "}
                              custom · {hash8(customSha(t.id) ?? "")}
                            </span>
                          )}
                        </span>
                      </label>
                      {t.description && (
                        <details className="pb-2 pl-6">
                          <summary className="cursor-pointer text-sm text-subtle">
                            Details ›
                          </summary>
                          <p className="text-base">{t.description}</p>
                        </details>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {list.length > 0 && types.data?.verifierReachable !== undefined && (
                <p className="text-base text-subtle">
                  {types.data.verifierReachable
                    ? `Verifier: reachable at ${verifierHost(types.data.verifierUrl ?? "the configured address")}`
                    : "Verifier: not reachable from the engine; tasks will be refused at deposit"}
                </p>
              )}
              {mapped && (
                <p role="status" className="text-base font-semibold">
                  The buyer agent mapped this to {mapped.id.toUpperCase()}
                  {mapped.reason ? `: ${mapped.reason}` : "."}
                </p>
              )}
              {disagree && selectedType && (
                <p role="status" className="text-base">
                  The buyer agent would map this text to none
                  {disagree.reason ? `: ${disagree.reason}` : "."} Your selection (
                  {list.find((t) => t.id === selectedType)?.title}) stands only if you confirm, and
                  the worker will refuse the job if it cannot be verified by that test.
                  {(() => {
                    const alt = list.find(
                      (t) =>
                        t.id !== selectedType &&
                        (disagree.reason.toLowerCase().includes(t.id.toLowerCase()) ||
                          disagree.reason.toLowerCase().includes(t.title.toLowerCase())),
                    );
                    return alt ? (
                      <>
                        {" "}
                        <button
                          type="button"
                          className="font-semibold underline"
                          onClick={() => {
                            setChosen(alt.id);
                            setDisagree(null);
                          }}
                        >
                          Use {alt.title} instead
                        </button>
                      </>
                    ) : null;
                  })()}
                </p>
              )}
              {installed && (
                <p role="status" className="text-base font-semibold">
                  Installed: <span className="font-mono">custom · {hash8(installed.sha)}</span>{" "}
                  {installed.title}. It is selected below.
                </p>
              )}
              {installed && (
                <p role="status" className="text-base">
                  Installed: {installed.hidden} hidden cases, 3 shown, {installed.rules} rules
                </p>
              )}
              {selectedType && (
                <p role="status" className="text-base">
                  Using the type you selected: {list.find((t) => t.id === selectedType)?.title}
                  {customSha(selectedType)
                    ? ` (custom · ${hash8(customSha(selectedType) ?? "")})`
                    : ""}
                  ; no check needed.
                </p>
              )}
              <p id={`${id}-tt`} className="text-base text-subtle">
                {selectedType
                  ? `Will be verified as: ${selectedType.toUpperCase()}. The buyer agent confirms the match before any payment.`
                  : "Verdict only buys work it can verify."}
              </p>
            </fieldset>
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
            {refusal && (
              <div
                role="alert"
                className=" border border-rule-soft border-l-4 border-l-bad bg-card px-4 py-2"
              >
                <p className="font-semibold">{refusal.message}</p>
                {refusal.reason && (
                  <p className="text-base">
                    Routing: the buyer agent answered none: {refusal.reason}
                  </p>
                )}
                <p className="text-base">Task types available today:</p>
                <ul>
                  {(refusal.types ?? list).map((t) => (
                    <li key={t.id} className="text-base">
                      {t.title}{" "}
                      <span className="font-mono text-sm uppercase text-subtle">{t.id}</span>
                    </li>
                  ))}
                </ul>
                <p className="text-base text-subtle">
                  To pay for a different kind of work, a test package for it must exist first: the
                  verifier releases money only when a fixed test passes. See docs/FAQ.md, 'Can I ask
                  for any task?'
                </p>
                <p className="text-base">Nothing was sent.</p>
              </div>
            )}
            {author.isPending && (
              <p role="status">Writing the acceptance test with the local model...</p>
            )}
            {authorError && (
              <p role="alert" className="font-semibold">
                {withNothingInstalled(authorError)}
              </p>
            )}
            {draft && edits && (
              <AcceptanceTest
                draft={draft}
                edits={edits}
                onEdit={setEdits}
                onInstall={() => void installDraft()}
                installing={install.isPending}
                error={installError}
              />
            )}
            {failure && (
              <p
                role="alert"
                className=" border border-rule-soft border-l-4 border-l-bad bg-card px-4 py-2 font-semibold"
              >
                {failure}
              </p>
            )}
            {lastAnswer && (
              <details>
                <summary className="cursor-pointer text-sm text-subtle">Last answer</summary>
                <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all font-mono text-sm">
                  {lastAnswer}
                </pre>
              </details>
            )}
            {overridden && (
              <p role="status" className="text-base">
                The buyer agent would not map this text to {selectedTitle}; the worker will refuse
                the job if its test cannot verify it. Confirm to proceed.
              </p>
            )}
            {selectedType === null && (
              <p role="status" className="text-base text-subtle">
                Pick a test type, press CHECK to let the buyer agent map your text, or WRITE A TEST.
              </p>
            )}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => void check()}
                disabled={route.isPending || start.isPending || description.trim().length < 3}
              >
                {route.isPending ? "Checking..." : "Check"}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => void writeTest()}
                disabled={author.isPending || start.isPending || description.trim().length < 3}
              >
                {author.isPending ? "Writing..." : "Write a test"}
              </Button>
              {overridden ? (
                <Button
                  type="button"
                  disabled={start.isPending}
                  onClick={() => void submit()}
                  className="uppercase"
                >
                  {start.isPending ? "Sending..." : `Use ${selectedTitle} anyway`}
                </Button>
              ) : (
                <Button type="submit" disabled={start.isPending || selectedType === null}>
                  {start.isPending ? "Sending..." : "Start task"}
                </Button>
              )}
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </section>
  );
}
