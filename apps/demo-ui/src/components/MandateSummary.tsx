import type { RootCapability } from "@verdict/protocol";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const time = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });

/** The signed root capability in plain language, raw JSON behind a disclosure. */
export function MandateSummary(props: {
  root: RootCapability;
  names: Record<string, string>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const r = props.root;
  const rows: [string, string][] = [
    ["Total budget", `At most ${r.max_total} tUSD in total`],
    ["Per task", `At most ${r.max_per_task} tUSD per task`],
    ["Spending", `Only for: ${r.allowed_categories.join(", ")}`],
    [
      "Who can be paid",
      r.allowed_payees.map((p) => props.names[p] ?? `${p.slice(0, 18)}…`).join(", ") ||
        "Nobody listed",
    ],
    ["Recurring", r.recurring ? "Recurring payments allowed" : "No recurring payments"],
    ["Expires", `Expires at ${time(r.expires_at)}`],
  ];
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="text-2xl">Your mandate</DialogTitle>
          <DialogDescription>
            The most the buyer agent may ever do for you. It cannot widen these rules.
          </DialogDescription>
        </DialogHeader>
        <dl className="grid gap-3">
          {rows.map(([k, v]) => (
            <div key={k}>
              <dt className="text-base text-muted-foreground">{k}</dt>
              <dd className="text-xl font-bold">{v}</dd>
            </div>
          ))}
        </dl>
        <details>
          <summary className="cursor-pointer text-base">Raw signed mandate (JSON)</summary>
          <pre className="mt-2 max-h-72 overflow-auto rounded bg-muted p-3 font-mono text-sm">
            {JSON.stringify(r, null, 2)}
          </pre>
        </details>
      </DialogContent>
    </Dialog>
  );
}
