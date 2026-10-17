import { FilePlus2 } from "lucide-react";
import { Button } from "@/components/ui/button";

/** Shown until a mandate exists: what Verdict is, in three lines, and the one thing to do. */
export function EmptyState(props: { onCreate: () => void }) {
  return (
    <section aria-label="Welcome" className="mx-auto max-w-2xl">
      <h2 className="font-display text-4xl font-bold">Give agents permissions, not wallets.</h2>
      <ol className="mt-8 grid gap-4 text-xl">
        <li>1. You sign a mandate: how much an agent may spend, on what, and until when.</li>
        <li>
          2. The agent's payment is locked in escrow and released only if an independent test
          passes.
        </li>
        <li>3. Anything outside the mandate is blocked before any money is signed.</li>
      </ol>
      <Button type="button" className="mt-8" onClick={props.onCreate}>
        <FilePlus2 aria-hidden />
        Create mandate
      </Button>
    </section>
  );
}
