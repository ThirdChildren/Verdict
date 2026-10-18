import { FileSignature, Lock, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";

const POINTS = [
  {
    icon: FileSignature,
    text: "You sign a mandate: how much an agent may spend, on what, and until when.",
  },
  {
    icon: Lock,
    text: "The agent's payment is locked in escrow and released only if an independent test passes.",
  },
  {
    icon: ShieldCheck,
    text: "Anything outside the mandate is blocked before any money is signed.",
  },
] as const;

/** Shown until a mandate exists: what Verdict is, in three numbered lines, and the one thing to do. */
export function EmptyState(props: { onCreate: () => void }) {
  return (
    <section
      aria-label="Welcome"
      className="animate-soft-in mx-auto max-w-2xl  border border-rule-soft bg-card p-8 shadow-lift"
    >
      <h2 className="text-3xl font-semibold">Give agents permissions, not wallets.</h2>
      <ol className="mt-6 grid gap-3 text-xl">
        {POINTS.map((p, i) => (
          <li key={p.text} className="flex items-start gap-4  bg-card p-4">
            <span className="grid size-10 shrink-0 place-items-center  bg-card text-signal shadow-soft">
              <p.icon aria-hidden className="size-5" />
            </span>
            <span>
              <span className="mr-1 font-mono text-subtle">{i + 1}.</span>
              {p.text}
            </span>
          </li>
        ))}
      </ol>
      <Button type="button" className="mt-8" onClick={props.onCreate}>
        Create mandate
      </Button>
    </section>
  );
}
