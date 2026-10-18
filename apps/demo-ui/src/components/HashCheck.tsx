import { Hash, middle } from "./Hash.js";
import { Mark } from "./Mark.js";

/** Shows a hash next to a result recomputed in the browser: matches -> verified (green check), differs -> MISMATCH (amber). */
export function HashCheck({
  label,
  shown,
  recomputed,
  note,
  matches,
  plain,
}: {
  label: string;
  /** The hash the services reported. */
  shown: string;
  /** The hash this browser computed itself, or null when the data is missing. */
  recomputed: string | null;
  note?: string;
  /** Overrides the plain equality test (used when the check is a cross-link, not a recompute). */
  matches?: boolean;
  /** Same row, but nothing is claimed as checked here (a value only reported by the verifier). */
  plain?: boolean;
}) {
  const ok = recomputed !== null && (matches ?? recomputed === shown);
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-rule-soft py-1.5 text-base">
      <Mark kind={ok || plain ? "done" : "attention"} />
      <span className="text-sm font-semibold uppercase">{label}</span>
      <Hash value={shown} label={label} />
      {plain ? null : recomputed === null ? (
        <span className="text-subtle">Cannot check yet: data missing.</span>
      ) : ok ? (
        <span className="font-semibold">verified in your browser</span>
      ) : (
        <span className="font-semibold">
          MISMATCH{recomputed === shown ? "" : `: this browser computed ${middle(recomputed)}`}
        </span>
      )}
      {note && <span className="text-sm text-subtle">{note}</span>}
    </div>
  );
}
