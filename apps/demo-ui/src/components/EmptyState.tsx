import { Button } from "@/components/ui/button";

/** Shown until a mandate exists: what Verdict is, in three numbered lines, and the one thing to do. */
export function EmptyState(props: { onCreate: () => void }) {
  return (
    <section aria-label="Welcome" className="mx-auto max-w-2xl">
      <h2 className="text-3xl font-semibold">Give agents permissions, not wallets.</h2>
      <ol className="mt-6 grid divide-y divide-rule-soft border-y border-rule text-xl">
        <li className="py-3">
          1. You sign a mandate: how much an agent may spend, on what, and until when.
        </li>
        <li className="py-3">
          2. The agent's payment is locked in escrow and released only if an independent test
          passes.
        </li>
        <li className="py-3">
          3. Anything outside the mandate is blocked before any money is signed.
        </li>
      </ol>
      <Button type="button" className="mt-8" onClick={props.onCreate}>
        Create mandate
      </Button>
    </section>
  );
}
