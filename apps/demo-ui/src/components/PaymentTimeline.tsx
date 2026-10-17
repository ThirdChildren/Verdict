import type { PaymentStatus } from "@verdict/protocol";
import { CheckCircle2, Circle, XCircle } from "lucide-react";
import { motion } from "motion/react";
import type { ChainInfo } from "../lib/queries.js";
import type { PaymentStep } from "../store.js";

/** Escrow (HODL) states in order. The wallet reports Settled; the screen calls it "Succeeded". */
export const TIMELINE: { status: PaymentStatus; label: string }[] = [
  { status: "Pending", label: "Pending (locked)" },
  { status: "Claimable", label: "Claimable" },
  { status: "Settled", label: "Succeeded" },
];

export const timeOf = (iso: string) => new Date(iso).toLocaleTimeString([], { hour12: false });

/** Escrow history as one quiet line: dot, word and time per state. The last reached state is the focus; Succeeded is green. */
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
      className="flex flex-wrap items-center gap-x-2 gap-y-1 text-base text-muted-foreground"
    >
      {rows.map((r, i) => {
        const when = at(r.status);
        const isCur = current === r.status;
        const bad = r.status === "Failed" && when;
        const good = r.status === "Settled" && when;
        const Icon = bad ? XCircle : when ? CheckCircle2 : Circle;
        const tone = bad ? "text-danger" : good ? "text-ok" : when ? "text-foreground" : "";
        return (
          <li
            key={r.status}
            aria-current={isCur ? "step" : undefined}
            className="flex items-center gap-2"
          >
            {i > 0 && <span aria-hidden className="h-px w-6 bg-border" />}
            <span className={`flex items-center gap-1.5 ${tone} ${isCur ? "font-semibold" : ""}`}>
              <Icon aria-hidden className="size-4 shrink-0" />
              {r.label}
              <span className="tabular-nums font-normal text-muted-foreground">
                {when ? timeOf(when) : "not yet"}
              </span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/** Progress ring relative to the lock start: blocks since the lock out of the blocks the lock lasts. */
export function BlockRing({ chain }: { chain: ChainInfo }) {
  const span = Math.max(1, chain.expiresAt - chain.lockedAt);
  const frac = Math.min(1, Math.max(0, (chain.height - chain.lockedAt) / span));
  const blocksDone = Math.min(span, Math.max(0, chain.height - chain.lockedAt));
  const r = 34;
  const c = 2 * Math.PI * r;
  return (
    <div className="flex items-center gap-4" aria-live="polite">
      <svg
        viewBox="0 0 80 80"
        className="size-14 shrink-0"
        role="img"
        aria-label={`${blocksDone} of about ${span} blocks of the lock time have passed`}
      >
        <circle cx="40" cy="40" r={r} fill="none" strokeWidth="8" className="stroke-border" />
        <motion.circle
          cx="40"
          cy="40"
          r={r}
          fill="none"
          strokeWidth="8"
          transform="rotate(-90 40 40)"
          className="stroke-warn"
          initial={false}
          animate={{ strokeDasharray: `${c * frac} ${c}` }}
          transition={{ duration: 0.5 }}
        />
      </svg>
      <p className="text-xl tabular-nums">
        <span className="font-bold">{blocksDone}</span> of ~{span} blocks
      </p>
    </div>
  );
}
