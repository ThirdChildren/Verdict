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
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-rule-soft py-1.5 text-base">
      <span aria-hidden>{ok ? "■" : "▲"}</span>
      <span className="text-sm font-semibold uppercase">{label}</span>
      <Hash value={shown} label={label} />
      {recomputed === null ? (
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
