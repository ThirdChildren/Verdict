import { zodResolver } from "@hookform/resolvers/zod";
import { useId, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { ApiError, type GoalResponse, type SignedMandate } from "../lib/api.js";
import { MIN_MANDATE_MINUTES, mandateDuration } from "../lib/mandateRules.js";
import { useProposeMandate, useSignMandate } from "../lib/queries.js";
import { useStore } from "../store.js";
import { BlockCard } from "./BlockCard.js";
import { Hash } from "./Hash.js";
import { Note } from "./Note.js";

export const goalSchema = z.object({
  goal: z.string().trim().min(3, "Write at least 3 characters.").max(1000),
});
type GoalValues = z.infer<typeof goalSchema>;

export const EXAMPLES = [
  "Pay up to 5 tUSD to worker to convert CSV files to JSON, within 12 hours",
  "Pay at most 2 tUSD to worker for one CSV to JSON conversion, within 12 hours",
];

const STEPS = ["Write", "Review", "Sign"] as const;

function payeesOf(m: GoalResponse["mandate"]): string[] {
  if (m.allowed_payees) return m.allowed_payees;
  if (Array.isArray(m.counterparties)) return m.counterparties;
  return [];
}

const hoursLeft = (minutes: number) =>
  minutes >= 120 ? `${Math.round(minutes / 60)} hours` : `${Math.max(minutes, 0)} minutes`;

function Stepper({ step }: { step: number }) {
  return (
    <ol aria-label="Mandate steps" className="flex flex-wrap items-baseline gap-x-3 text-base">
      {STEPS.map((label, i) => (
        <li
          key={label}
          aria-current={i === step ? "step" : undefined}
          className={`flex items-baseline gap-x-3 uppercase ${i === step ? "font-semibold text-ink" : "text-subtle"}`}
        >
          {i > 0 && <span aria-hidden>—</span>}
          <span>
            <span className="font-mono">{i + 1}</span> {label}
          </span>
        </li>
      ))}
    </ol>
  );
}

function WriteStep(props: { onProposed: (goal: string, data: GoalResponse) => void }) {
  const id = useId();
  const form = useForm<GoalValues>({
    resolver: zodResolver(goalSchema),
    defaultValues: { goal: "" },
  });
  const propose = useProposeMandate();
  const submit = form.handleSubmit(async ({ goal }) => {
    try {
      props.onProposed(goal, await propose.mutateAsync(goal));
    } catch {
      // shown from the mutation state below
    }
  });
  const err = form.formState.errors.goal;
  return (
    <form onSubmit={submit} noValidate className="grid w-full gap-4">
      <Label htmlFor={id} className="text-xl font-semibold">
        What should the agent get done, and how much may it spend?
      </Label>
      <textarea
        id={id}
        rows={4}
        aria-invalid={err !== undefined}
        placeholder="Say it in your own words, with an amount and a time limit."
        className="w-full resize-none border border-input bg-paper p-4 text-xl outline-none focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-ink"
        {...form.register("goal")}
      />
      {err && (
        <p role="alert" className="font-semibold">
          <span aria-hidden>▲ </span>
          {err.message}
        </p>
      )}
      <div className="grid justify-items-start gap-1">
        <span className="text-sm text-subtle uppercase">Try an example</span>
        {EXAMPLES.map((ex) => (
          <button
            key={ex}
            type="button"
            onClick={() => form.setValue("goal", ex, { shouldValidate: true })}
            className="cursor-pointer text-left text-base underline decoration-rule underline-offset-4 outline-none hover:decoration-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
          >
            {ex}
          </button>
        ))}
      </div>
      <div aria-live="polite">
        {propose.error && (
          <Note role="alert">
            <p className="font-semibold">
              {propose.error instanceof ApiError
                ? propose.error.message
                : "Something went wrong. Nothing was signed."}
            </p>
          </Note>
        )}
      </div>
      <Button type="submit" disabled={propose.isPending} className="justify-self-start">
        {propose.isPending ? "Drafting mandate..." : "Draft mandate"}
      </Button>
    </form>
  );
}

function Fact(props: { label: string; big: string; small?: string }) {
  return (
    <div className="grid content-start gap-1 border-b border-rule-soft p-3">
      <dt className="text-sm text-subtle uppercase">{props.label}</dt>
      <dd className="font-mono text-3xl font-semibold">{props.big}</dd>
      {props.small && <dd className="text-base text-subtle">{props.small}</dd>}
    </div>
  );
}

function ReviewStep(props: {
  goal: string;
  proposal: GoalResponse;
  onBack: () => void;
  onSigned: (s: SignedMandate) => void;
}) {
  const { proposal } = props;
  const m = proposal.mandate;
  const [second, setSecond] = useState(false);
  // Set when the signer itself found the mandate unusual (its answer is HTTP 428 with a single-use token).
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const checkId = useId();
  const sign = useSignMandate();
  const duration = mandateDuration(m.expires_at);
  const askSecond = proposal.needs_second_confirm || token !== null;
  const canApprove = !sign.isPending && duration.ok && (!askSecond || second);
  const payees = payeesOf(m);
  const categories = m.allowed_categories ?? [];

  const approve = async () => {
    setError(null);
    try {
      props.onSigned(
        await sign.mutateAsync({
          goal: props.goal,
          proposal: m,
          second,
          ...(token ? { token } : {}),
        }),
      );
    } catch (e) {
      if (e instanceof ApiError && e.confirmToken) {
        setToken(e.confirmToken);
        setSecond(false);
      }
      setError(
        e instanceof ApiError
          ? e
          : new ApiError("ERROR", "Something went wrong. Nothing was signed."),
      );
    }
  };

  return (
    <div className="grid w-full gap-4">
      {proposal.flags.length > 0 && (
        <Note title="Check this: it differs from what you wrote">
          <ul className="list-disc pl-6">
            {proposal.flags.map((f) => (
              <li key={f.code}>{f.message}</li>
            ))}
          </ul>
        </Note>
      )}
      <dl className="grid grid-cols-2 border-y border-rule [&>*:nth-child(odd)]:border-r [&>*:nth-child(odd)]:border-rule-soft">
        <Fact
          label="Spending ceiling"
          big={`${m.max_total} tUSD`}
          small={`At most ${m.max_per_task} tUSD per task. No recurring payments.`}
        />
        <Fact
          label="Expires"
          big={`In ${hoursLeft(duration.minutesLeft)}`}
          small={`At ${new Date(m.expires_at).toLocaleString([], { hour: "2-digit", minute: "2-digit", day: "numeric", month: "short" })}`}
        />
        <div className="grid content-start gap-1 border-b border-rule-soft p-3">
          <dt className="text-sm text-subtle uppercase">Allowed workers</dt>
          {payees.length === 0 ? (
            <dd className="text-xl font-semibold">Nobody listed</dd>
          ) : (
            payees.map((id) => (
              <dd key={id} className="flex flex-wrap items-center gap-2 text-xl font-semibold">
                {m.payee_names?.[id] ?? "Approved worker"}
                <Hash value={id} label="worker id" />
              </dd>
            ))
          )}
        </div>
        <div className="grid content-start gap-1 border-b border-rule-soft p-3">
          <dt className="text-sm text-subtle uppercase">Allowed category</dt>
          <dd className="text-xl font-semibold">
            {categories.length ? categories.join(", ") : "Not listed"}
          </dd>
        </div>
      </dl>
      {!duration.ok && (
        <Note title="Too short for one task" role="alert">
          <p>
            A task locks the payment for a while: the work, the check and a safety margin. This
            mandate ends in {hoursLeft(duration.minutesLeft)}, but the engine needs at least{" "}
            {MIN_MANDATE_MINUTES / 60} hours. Go back and ask for a longer one, for example "within
            12 hours".
          </p>
        </Note>
      )}
      <details>
        <summary className="cursor-pointer text-base">Raw mandate (JSON)</summary>
        <pre className="mt-2 max-h-56 overflow-auto border border-rule p-3 font-mono text-sm">
          {JSON.stringify(m, null, 2)}
        </pre>
      </details>
      {askSecond && (
        <div className="flex items-start gap-3 border-l-2 border-ink py-1 pl-4">
          <Checkbox
            id={checkId}
            checked={second}
            onCheckedChange={(v) => setSecond(v === true)}
            className="mt-1 size-6"
          />
          <Label htmlFor={checkId} className="text-xl font-semibold">
            I understand this amount is not in my text. Sign anyway.
          </Label>
        </div>
      )}
      <div aria-live="polite">
        {error &&
          (error.blockCode ? (
            <BlockCard code={error.blockCode} message={error.message} />
          ) : (
            <Note role="alert">
              <p className="font-semibold">
                {error.message}
                {error.confirmToken ? "" : " Nothing was signed. No funds moved."}
              </p>
            </Note>
          ))}
      </div>
      <div className="sticky bottom-0 -mb-4 flex gap-3 border-t border-rule bg-paper py-4">
        <Button type="button" variant="outline" onClick={props.onBack}>
          Back
        </Button>
        <Button type="button" disabled={!canApprove} onClick={approve}>
          {sign.isPending ? "Signing..." : "Approve and sign"}
        </Button>
      </div>
    </div>
  );
}

function SignedStep(props: { signed: SignedMandate; onClose: () => void }) {
  return (
    <div className="grid w-full gap-6" aria-live="polite">
      <p className="border-y-2 border-ink py-2 text-2xl font-semibold">
        Signed by the principal (separate process)
      </p>
      <p className="text-xl">
        The signing key lives in its own process on this machine. The agents and this screen never
        hold it. The engine now enforces this mandate.
      </p>
      <dl className="grid divide-y divide-rule-soft border-y border-rule">
        <div className="flex items-center gap-3 py-2">
          <dt className="w-32 text-sm text-subtle uppercase">Signature</dt>
          <dd>
            <Hash value={props.signed.signature} label="signature" />
          </dd>
        </div>
        <div className="flex items-center gap-3 py-2">
          <dt className="w-32 text-sm text-subtle uppercase">Mandate id</dt>
          <dd>
            <Hash value={props.signed.capHash} label="mandate id" />
          </dd>
        </div>
      </dl>
      <Button type="button" onClick={props.onClose} className="justify-self-start">
        Start working
      </Button>
    </div>
  );
}

/** Full-screen, three-step mandate flow: write it, review it in plain language, see it signed. */
export function MandateWizard(props: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<{ goal: string; data: GoalResponse } | null>(null);
  const [signed, setSigned] = useState<SignedMandate | null>(null);
  const close = (open: boolean) => {
    props.onOpenChange(open);
    if (!open) {
      setStep(0);
      setDraft(null);
      setSigned(null);
    }
  };
  return (
    <Dialog open={props.open} onOpenChange={close}>
      <DialogContent className="h-screen max-h-screen content-start gap-6 overflow-auto p-8 sm:max-w-3xl">
        <div className="mx-auto grid w-full max-w-3xl gap-4">
          <header className="grid gap-3">
            <DialogTitle className="text-3xl font-semibold">Create mandate</DialogTitle>
            <DialogDescription>
              A mandate is the most the buyer agent may ever spend for you. Write it, check it, sign
              it.
            </DialogDescription>
            <Stepper step={step} />
          </header>
          <div key={step}>
            {step === 0 && (
              <WriteStep
                onProposed={(goal, data) => {
                  setDraft({ goal, data });
                  setStep(1);
                }}
              />
            )}
            {step === 1 && draft && (
              <ReviewStep
                goal={draft.goal}
                proposal={draft.data}
                onBack={() => setStep(0)}
                onSigned={(s) => {
                  useStore.getState().setPayeeNames(draft.data.mandate.payee_names ?? {});
                  setSigned(s);
                  setStep(2);
                }}
              />
            )}
            {step === 2 && signed && <SignedStep signed={signed} onClose={() => close(false)} />}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
