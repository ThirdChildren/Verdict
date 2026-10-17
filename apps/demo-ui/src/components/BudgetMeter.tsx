import { CheckCircle2, Lock, Wallet } from "lucide-react";
import { motion } from "motion/react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { toMinor } from "../lib/money.js";
import type { AppState, BudgetView } from "../store.js";

const SEGMENTS = [
  {
    key: "committed",
    label: "Paid",
    Icon: CheckCircle2,
    bar: "bg-ok",
    tip: "Paid: already sent to workers.",
  },
  {
    key: "reserved",
    label: "Locked",
    Icon: Lock,
    bar: "bg-warn",
    tip: "Locked: held in escrow for work in progress; returns to you if the task fails.",
  },
  {
    key: "remaining",
    label: "Left",
    Icon: Wallet,
    bar: "bg-border",
    tip: "Left: still available for new tasks under this mandate.",
  },
] as const;

/** Geometry only: percentages of the three engine-reported strings. The numbers shown are the engine's strings. */
export function segmentWidths(b: BudgetView, precision: number): Record<string, number> {
  const m = {
    committed: toMinor(b.committed, precision),
    reserved: toMinor(b.reserved, precision),
    remaining: toMinor(b.remaining, precision),
  };
  const total = m.committed + m.reserved + m.remaining;
  const pct = (v: bigint) => (total === 0n ? 0 : Number((v * 10000n) / total) / 100);
  return { committed: pct(m.committed), reserved: pct(m.reserved), remaining: pct(m.remaining) };
}

export function BudgetMeter({ state }: { state: AppState }) {
  const b = state.budget;
  if (!state.root) {
    return <div className="flex-1" />;
  }
  const w = b ? segmentWidths(b, state.precision) : null;
  return (
    <section aria-label="Budget" className="min-w-fit flex-1">
      <TooltipProvider>
        <dl className="flex items-end gap-x-8 whitespace-nowrap" aria-live="polite">
          {SEGMENTS.map((s) => (
            <Tooltip key={s.key}>
              <TooltipTrigger asChild>
                <div>
                  <dt className="flex items-center gap-1 text-sm text-muted-foreground">
                    <s.Icon aria-hidden className="size-4" />
                    {s.label}
                  </dt>
                  <dd className="text-2xl leading-8 tabular-nums">{b ? b[s.key] : "—"}</dd>
                </div>
              </TooltipTrigger>
              <TooltipContent>{s.tip}</TooltipContent>
            </Tooltip>
          ))}
          <div className="pb-0.5 text-sm text-muted-foreground">of {state.root.max_total} tUSD</div>
        </dl>
      </TooltipProvider>
      <div
        className="mt-2 flex h-2 w-full overflow-hidden rounded-full bg-border"
        role="img"
        aria-label={
          b
            ? `Paid ${b.committed}, locked ${b.reserved}, left ${b.remaining} of ${state.root.max_total} tUSD`
            : "Budget amounts not reported yet"
        }
      >
        {w &&
          SEGMENTS.filter((s) => s.key !== "remaining").map((s) => (
            <motion.div
              key={s.key}
              className={s.bar}
              initial={false}
              animate={{ width: `${w[s.key]}%` }}
              transition={{ duration: 0.5 }}
            />
          ))}
      </div>
      {state.confirming.length > 0 && (
        <p role="status" className="mt-1 text-sm text-warn-soft-foreground">
          Payment being confirmed: the amount stays held until the wallet reports.
        </p>
      )}
    </section>
  );
}
