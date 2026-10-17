import { Archive, TriangleAlert } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { fromMinor, toMinor } from "../lib/money.js";
import type { AppState, BudgetView } from "../store.js";

const SEGMENTS = [
  {
    key: "committed",
    label: "Paid",
    bar: "bg-signal",
    tip: "Paid: already sent to workers.",
  },
  {
    key: "reserved",
    label: "Locked",
    bar: "bg-warn",
    tip: "Locked: held in escrow for work in progress; returns to you if the task fails.",
  },
  {
    key: "remaining",
    label: "Left",
    bar: "bg-rule-soft",
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

/** The budget as one ledger line in mono (PAID 1.20 · LOCKED 0.00 · LEFT 3.80 / 5.00 tUSD) and a plain 4px rule. */
export function BudgetMeter({
  state,
  ceiling,
  frozenAt,
}: {
  state: AppState;
  /** Ceiling of the shown mandate when it is not the live root. */
  ceiling?: string;
  /** Retirement time (HH:MM:SS) of a frozen mandate: its figures do not move. */
  frozenAt?: string;
}) {
  const b = state.budget;
  if (!state.root) {
    return <div className="flex-1" />;
  }
  const w = b ? segmentWidths(b, state.precision) : null;
  return (
    <section aria-label="Budget" className="min-w-0 shrink-0">
      <TooltipProvider>
        <p
          className="flex items-baseline gap-x-1.5 font-mono text-sm whitespace-nowrap uppercase"
          aria-live="polite"
        >
          {SEGMENTS.map((s, i) => (
            <span key={s.key} className="flex items-baseline gap-x-1.5">
              {i > 0 && <span aria-hidden>·</span>}
              <Tooltip>
                <TooltipTrigger asChild>
                  <span>
                    <span className="text-subtle">{s.label}</span>{" "}
                    <span className="text-base font-semibold">
                      {b ? b[s.key] : fromMinor(0n, state.precision)}
                    </span>
                  </span>
                </TooltipTrigger>
                <TooltipContent>{s.tip}</TooltipContent>
              </Tooltip>
            </span>
          ))}
          <span className="hidden text-xs text-subtle min-[1360px]:inline">
            / {ceiling ?? state.root.max_total} tUSD
          </span>
        </p>
      </TooltipProvider>
      <div
        className="mt-1.5 flex h-1.5 w-full overflow-hidden rounded-full bg-rule-soft/70"
        role="img"
        aria-label={
          b
            ? `Paid ${b.committed}, locked ${b.reserved}, left ${b.remaining} of ${ceiling ?? state.root.max_total} tUSD`
            : "Budget amounts not reported yet"
        }
      >
        {w &&
          SEGMENTS.filter((s) => s.key !== "remaining").map((s) => (
            <div
              key={s.key}
              className={`${s.bar} transition-[width] duration-500 ease-out`}
              style={{ width: `${w[s.key]}%` }}
            />
          ))}
      </div>
      {frozenAt && (
        <p className="mt-1 font-mono text-xs uppercase">
          <Archive aria-hidden className="mr-1 inline size-3.5" />
          At retirement {frozenAt}
        </p>
      )}
      {!frozenAt && state.confirming.length > 0 && (
        <p role="status" className="mt-1 text-sm font-semibold text-warn">
          <TriangleAlert aria-hidden className="mr-1 inline size-4 align-[-0.15em]" />
          Payment being confirmed: the amount stays held until the wallet reports.
        </p>
      )}
    </section>
  );
}
