import { zodResolver } from "@hookform/resolvers/zod";
import { AlertTriangle, ArrowRight, Check, FileSignature, ShieldCheck } from "lucide-react";
import { motion } from "motion/react";
import { useId, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
    <ol aria-label="Mandate steps" className="flex items-center gap-4 text-base">
      {STEPS.map((label, i) => {
        const done = i < step;
        const now = i === step;
        return (
          <li
            key={label}
            aria-current={now ? "step" : undefined}
            className={`flex items-center gap-2 ${now ? "font-semibold text-foreground" : "text-muted-foreground"}`}
          >
            <span
              className={`flex size-7 items-center justify-center rounded-full border text-sm ${now ? "border-primary bg-primary text-primary-foreground" : done ? "border-info-border bg-info-soft text-info-soft-foreground" : ""}`}
            >
              {done ? <Check aria-hidden className="size-4" /> : i + 1}
            </span>
            {label}
            {i < STEPS.length - 1 && <span aria-hidden className="ml-2 h-px w-8 bg-border" />}
          </li>
        );
      })}
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
        className="w-full resize-none rounded-lg border border-input bg-background p-4 text-xl outline-none focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-ink"
        {...form.register("goal")}
      />
      {err && (
        <p role="alert" className="font-semibold text-warn-soft-foreground">
          {err.message}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-muted-foreground">Try an example</span>
        {EXAMPLES.map((ex) => (
          <button
            key={ex}
            type="button"
            onClick={() => form.setValue("goal", ex, { shouldValidate: true })}
            className="rounded-full border px-3 py-1 text-left text-sm hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
          >
            {ex}
          </button>
        ))}
      </div>
      <div aria-live="polite">
        {propose.error && (
          <Alert variant="warn">
            <AlertDescription className="font-semibold text-warn-soft-foreground">
              {propose.error instanceof ApiError
                ? propose.error.message
                : "Something went wrong. Nothing was signed."}
            </AlertDescription>
          </Alert>
        )}
      </div>
      <Button type="submit" disabled={propose.isPending} className="justify-self-start">
        {propose.isPending ? "Drafting mandate..." : "Draft mandate"}
        <ArrowRight aria-hidden />
      </Button>
    </form>
  );
}

function Fact(props: { label: string; big: string; small?: string }) {
  return (
    <div className="grid gap-1">
      <dt className="text-sm text-muted-foreground">{props.label}</dt>
      <dd className="text-4xl font-semibold tabular-nums">{props.big}</dd>
      {props.small && <dd className="text-base text-muted-foreground">{props.small}</dd>}
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
        <Alert variant="warn" className="p-4">
          <AlertTriangle aria-hidden />
          <AlertTitle className="line-clamp-none text-xl font-semibold">
            Check this: it differs from what you wrote
          </AlertTitle>
          <AlertDescription className="text-warn-soft-foreground">
            <ul className="mt-1 list-disc pl-6">
              {proposal.flags.map((f) => (
                <li key={f.code}>{f.message}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}
      <dl className="grid grid-cols-2 gap-x-8 gap-y-6">
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
        <div className="grid gap-1">
          <dt className="text-sm text-muted-foreground">Allowed workers</dt>
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
        <div className="grid gap-1">
          <dt className="text-sm text-muted-foreground">Allowed category</dt>
          <dd className="text-xl font-semibold">
            {categories.length ? categories.join(", ") : "Not listed"}
          </dd>
        </div>
      </dl>
      {!duration.ok && (
        <Alert variant="warn" className="p-4" role="alert">
          <AlertTriangle aria-hidden />
          <AlertTitle className="line-clamp-none text-xl font-semibold">
            Too short for one task
          </AlertTitle>
          <AlertDescription className="text-warn-soft-foreground">
            A task locks the payment for a while: the work, the check and a safety margin. This
            mandate ends in {hoursLeft(duration.minutesLeft)}, but the engine needs at least{" "}
            {MIN_MANDATE_MINUTES / 60} hours. Go back and ask for a longer one, for example "within
            12 hours".
          </AlertDescription>
        </Alert>
      )}
      <details>
        <summary className="cursor-pointer text-base">Raw mandate (JSON)</summary>
        <pre className="mt-2 max-h-56 overflow-auto rounded bg-muted p-3 font-mono text-sm">
          {JSON.stringify(m, null, 2)}
        </pre>
      </details>
      {askSecond && (
        <div className="flex items-start gap-3 rounded-lg border border-warn-border bg-warn-soft p-4">
          <Checkbox
            id={checkId}
            checked={second}
            onCheckedChange={(v) => setSecond(v === true)}
            className="mt-1 size-6"
          />
          <Label htmlFor={checkId} className="text-xl font-semibold text-warn-soft-foreground">
            I understand this amount is not in my text. Sign anyway.
          </Label>
        </div>
      )}
      <div aria-live="polite">
        {error &&
          (error.blockCode ? (
            <BlockCard code={error.blockCode} message={error.message} />
          ) : (
            <Alert variant="warn" className="p-4">
              <AlertDescription className="font-semibold text-warn-soft-foreground">
                {error.message}
                {error.confirmToken ? "" : " Nothing was signed. No funds moved."}
              </AlertDescription>
            </Alert>
          ))}
      </div>
      <div className="sticky bottom-0 -mb-4 flex gap-3 border-t bg-background py-4">
        <Button type="button" variant="outline" onClick={props.onBack}>
          Back
        </Button>
        <Button type="button" disabled={!canApprove} onClick={approve}>
          <FileSignature aria-hidden />
          {sign.isPending ? "Signing..." : "Approve and sign"}
        </Button>
      </div>
    </div>
  );
}

function SignedStep(props: { signed: SignedMandate; onClose: () => void }) {
  return (
    <div className="grid w-full gap-6" aria-live="polite">
      <div className="flex items-center gap-3 text-info-soft-foreground">
        <ShieldCheck aria-hidden className="size-10" />
        <p className="text-2xl font-semibold">Signed by the principal (separate process)</p>
      </div>
      <p className="text-xl">
        The signing key lives in its own process on this machine. The agents and this screen never
        hold it. The engine now enforces this mandate.
      </p>
      <dl className="grid gap-2">
        <div className="flex items-center gap-3">
          <dt className="text-base text-muted-foreground">Signature</dt>
          <dd>
            <Hash value={props.signed.signature} label="signature" />
          </dd>
        </div>
        <div className="flex items-center gap-3">
          <dt className="text-base text-muted-foreground">Mandate id</dt>
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
            <DialogTitle className="font-display text-4xl font-semibold">
              Create mandate
            </DialogTitle>
            <DialogDescription>
              A mandate is the most the buyer agent may ever spend for you. Write it, check it, sign
              it.
            </DialogDescription>
            <Stepper step={step} />
          </header>
          <motion.div
            key={step}
            initial={{ opacity: 0, x: 12 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.18 }}
          >
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
                  toast.success("Mandate signed and active.");
                  setSigned(s);
                  setStep(2);
                }}
              />
            )}
            {step === 2 && signed && <SignedStep signed={signed} onClose={() => close(false)} />}
          </motion.div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
