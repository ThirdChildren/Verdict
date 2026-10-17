import { intentSummary } from "../lib/view.js";
import type { BlockEntry } from "../store.js";
import { BlockCard } from "./BlockCard.js";

const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour12: false });

/** Scene for a refused request: what was tried, which rule stopped it, and that nothing moved. */
export function BlockedScene(props: {
  block: BlockEntry;
  names: Record<string, string>;
  /** Budget left, as the engine reported it; null when unknown (then the sentence is omitted). */
  remaining?: string | null;
}) {
  const { block } = props;
  const it = intentSummary(block.intent);
  const payee = it.counterparty ? (props.names[it.counterparty] ?? it.counterparty) : null;
  // Only what the agent actually stated; an unknown field is left out instead of saying "not stated".
  const tried: [string, string][] = [];
  if (it.amount) tried.push(["Amount", `${it.amount} tUSD`]);
  if (payee) tried.push(["Payee", payee]);
  if (it.category) tried.push(["Category", it.category]);
  return (
    <div className="grid gap-8">
      <header className="grid gap-1">
        <p className="text-base text-muted-foreground">Blocked attempt · {time(block.at)}</p>
        <h2 className="font-display text-2xl font-bold">
          The agent tried something outside its mandate
        </h2>
      </header>
      {tried.length > 0 && (
        <section aria-label="What the agent tried">
          <h3 className="mb-2 text-base font-semibold">What the agent tried</h3>
          <dl className="flex flex-wrap gap-x-12 gap-y-4">
            {tried.map(([k, v]) => (
              <div key={k}>
                <dt className="text-base text-muted-foreground">{k}</dt>
                <dd className="text-xl break-all">{v}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}
      <BlockCard code={block.code} message={block.message} remaining={props.remaining} />
    </div>
  );
}
