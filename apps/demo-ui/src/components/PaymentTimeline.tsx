import type { PaymentStatus } from "@verdict/protocol";
import type { ChainInfo } from "../lib/queries.js";
import type { PaymentStep } from "../store.js";

/** Escrow (HODL) states in order. The wallet reports Settled; the screen calls it "Succeeded". */
export const TIMELINE: { status: PaymentStatus; label: string }[] = [
  { status: "Pending", label: "Pending (locked)" },
  { status: "Claimable", label: "Claimable" },
  { status: "Settled", label: "Succeeded" },
];

export const timeOf = (iso: string) => new Date(iso).toLocaleTimeString([], { hour12: false });

/** Escrow history as one mono line: STATE time › STATE time. The last reached state is bold. */
export function Timeline({ history }: { history: PaymentStep[] }) {
  const at = (s: PaymentStatus) => history.find((h) => h.status === s)?.at;
  const failed = at("Failed");
  const rows = failed
    ? [...TIMELINE.slice(0, 2), { status: "Failed" as const, label: "Failed" }]
    : TIMELINE;
  const current = history[history.length - 1]?.status;
  return (
    <ol
      aria-label="Escrow payment history"
      className="flex flex-wrap items-baseline gap-x-2 gap-y-1 font-mono text-sm uppercase text-subtle"
    >
      {rows.map((r, i) => {
        const when = at(r.status);
        const isCur = current === r.status;
        return (
          <li
            key={r.status}
            aria-current={isCur ? "step" : undefined}
            className={`flex items-baseline gap-x-2 ${when ? "text-ink" : ""} ${isCur ? "font-semibold" : ""}`}
          >
            {i > 0 && <span aria-hidden>›</span>}
            <span>{r.label}</span>
            <span className="font-normal">{when ? timeOf(when) : "not yet"}</span>
          </li>
        );
      })}
    </ol>
  );
}

/** Lock progress as a plain rule: blocks since the lock out of the blocks the lock lasts. */
export function BlockRing({ chain }: { chain: ChainInfo }) {
  const span = Math.max(1, chain.expiresAt - chain.lockedAt);
  const frac = Math.min(1, Math.max(0, (chain.height - chain.lockedAt) / span));
  const blocksDone = Math.min(span, Math.max(0, chain.height - chain.lockedAt));
  return (
    <div className="grid gap-1" aria-live="polite">
      <div
        role="img"
        aria-label={`${blocksDone} of about ${span} blocks of the lock time have passed`}
        className="h-1 w-full bg-rule-soft"
      >
        <div className="h-full bg-ink" style={{ width: `${frac * 100}%` }} />
      </div>
      <p className="font-mono text-base uppercase">
        <span className="font-semibold">{blocksDone}</span> of ~{span} blocks
      </p>
    </div>
  );
}
