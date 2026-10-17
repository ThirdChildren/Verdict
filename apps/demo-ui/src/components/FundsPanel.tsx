import { WordButton } from "@/components/ui/word-button";
import { connectPrincipal } from "../lib/principal.js";
import { useFunds } from "../lib/queries.js";
import { useStore } from "../store.js";

function Figure(props: { label: string; value: string | null; bold?: boolean }) {
  return (
    <div className="flex items-baseline gap-2">
      <dt className="text-sm text-subtle uppercase">{props.label}</dt>
      <dd className={`font-mono text-lg ${props.bold ? "font-semibold" : ""}`}>
        {props.value ?? "…"}
      </dd>
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
        className="flex flex-wrap items-baseline gap-x-4 border-b-2 border-ink px-6 py-2"
      >
        <p className="font-semibold">
          <span aria-hidden>▲ </span>
          {principal.message}
        </p>
        <p className="text-subtle">Nothing was signed and no funds moved.</p>
        <WordButton onClick={() => void connectPrincipal()}>Retry</WordButton>
      </div>
    );
  if (!connected) return null;
  return (
    <section
      aria-label="Funds"
      className="flex flex-wrap items-baseline gap-x-8 gap-y-1 border-b border-rule px-6 py-2"
    >
      <h2 className="text-sm text-subtle uppercase">Regtest test asset (tUSD)</h2>
      {funds.isError ? (
        <p role="status" className="font-semibold">
          <span aria-hidden>▲ </span>
          {funds.error instanceof Error ? funds.error.message : "The funds are unknown right now."}
        </p>
      ) : (
        <dl className="flex flex-wrap items-baseline gap-x-8 gap-y-1">
          <Figure label="Spendable in channel" value={funds.data?.spendable ?? null} />
          <Figure label="Reserved by open tasks" value={funds.data?.reserved ?? null} />
          <Figure
            label="Available to delegate"
            value={funds.data?.available_to_delegate ?? null}
            bold
          />
        </dl>
      )}
    </section>
  );
}
