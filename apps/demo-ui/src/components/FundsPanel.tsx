import { ArrowUpRight, Lock, TriangleAlert, Wallet } from "lucide-react";
import type { ReactNode } from "react";
import { WordButton } from "@/components/ui/word-button";
import { connectPrincipal } from "../lib/principal.js";
import { useFunds } from "../lib/queries.js";
import { useStore } from "../store.js";

function Figure(props: { icon: ReactNode; label: string; value: string | null; strong?: boolean }) {
  return (
    <div
      className={`flex items-center gap-3  border px-3.5 py-2 shadow-soft transition ${props.strong ? "border-signal/40 bg-card ring-2 ring-signal/10" : "border-rule-soft bg-card/70"}`}
    >
      <span className="grid size-8 place-items-center  bg-bitcoin/15 text-signal [&_svg]:size-4">
        {props.icon}
      </span>
      <div className="grid leading-tight">
        <dt className="text-xs text-subtle uppercase">{props.label}</dt>
        <dd className={`font-mono text-lg ${props.strong ? "font-semibold" : ""}`}>
          {props.value ?? "…"}
        </dd>
      </div>
    </div>
  );
}

/**
 * Under the header once a principal is connected: how much of the buyer's tUSD can be spent, is held by open tasks,
 * and could still be delegated to a mandate. The figures come from the engine as strings.
 */
export function FundsPanel() {
  const principal = useStore((s) => s.principal);
  const connected = principal.status === "connected";
  const funds = useFunds(connected);
  if (principal.status === "error")
    return (
      <div
        role="alert"
        className="animate-soft-in flex flex-wrap items-center gap-x-4 gap-y-1  border border-bad/40 bg-bad/8 px-4 py-2.5"
      >
        <TriangleAlert aria-hidden className="size-5 text-bad" />
        <p className="font-semibold">{principal.message}</p>
        <p className="text-subtle">Nothing was signed and no funds moved.</p>
        <WordButton onClick={() => void connectPrincipal()}>Retry</WordButton>
      </div>
    );
  if (!connected) return null;
  return (
    <section
      aria-label="Funds"
      className="animate-soft-in flex flex-wrap items-center gap-x-4 gap-y-2"
    >
      <h2 className="text-xs font-semibold tracking-wide text-subtle uppercase">
        Regtest test asset (tUSD)
      </h2>
      {funds.isError ? (
        <p role="status" className="flex items-center gap-2 font-semibold text-warn">
          <TriangleAlert aria-hidden className="size-4" />
          {funds.error instanceof Error ? funds.error.message : "The funds are unknown right now."}
        </p>
      ) : (
        <dl className="flex flex-wrap items-center gap-3">
          <Figure
            icon={<Wallet aria-hidden />}
            label="Spendable in channel"
            value={funds.data?.spendable ?? null}
          />
          <Figure
            icon={<Lock aria-hidden />}
            label="Reserved by open tasks"
            value={funds.data?.reserved ?? null}
          />
          <Figure
            icon={<ArrowUpRight aria-hidden />}
            label="Available to delegate"
            value={funds.data?.available_to_delegate ?? null}
            strong
          />
        </dl>
      )}
    </section>
  );
}
