import { CheckCircle2, TriangleAlert } from "lucide-react";

import { Hash, middle } from "./Hash.js";

/** Shows a hash next to a result recomputed in the browser: matches -> verified (blue), differs -> MISMATCH (amber). */
export function HashCheck({
  label,
  shown,
  recomputed,
  note,
  matches,
}: {
  label: string;
  /** The hash the services reported. */
  shown: string;
  /** The hash this browser computed itself, or null when the data is missing. */
  recomputed: string | null;
  note?: string;
  /** Overrides the plain equality test (used when the check is a cross-link, not a recompute). */
  matches?: boolean;
}) {
  const ok = recomputed !== null && (matches ?? recomputed === shown);
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-base">
      <span className="font-semibold">{label}</span>
      <Hash value={shown} label={label} />
      {recomputed === null ? (
        <span className="text-muted-foreground">Cannot check yet: data missing.</span>
      ) : ok ? (
        <span className="inline-flex items-center gap-1 font-semibold text-info-soft-foreground">
          <CheckCircle2 aria-hidden className="size-5" />
          verified in your browser
        </span>
      ) : (
        <span className="inline-flex items-center gap-1 rounded bg-warn-soft px-2 font-bold text-warn-soft-foreground">
          <TriangleAlert aria-hidden className="size-5" />
          MISMATCH{recomputed === shown ? "" : `: this browser computed ${middle(recomputed)}`}
        </span>
      )}
      {note && <span className="text-sm text-muted-foreground">{note}</span>}
    </div>
  );
}
