import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { setStatsOpen, useStatsOpen } from "../lib/statsPanel.js";
import { glyphBar, pct, seconds } from "../lib/statsView.js";
import { fetchVerifierStats, type PackageStats } from "../lib/verifierApi.js";

export const STATS_CAPTION =
  "Every run of every test package on this verifier: how often deliveries pass, how consistent the verdicts are, and how well workers predict them.";

const Fig = (p: { label: string; value: string }) => (
  <span className="whitespace-nowrap">
    <span className="text-sm uppercase tracking-wide text-subtle">{p.label} </span>
    <span className="font-mono tabular-nums font-semibold">{p.value}</span>
  </span>
);

function PackageRow({ pkg }: { pkg: PackageStats }) {
  const [open, setOpen] = useState(false);
  const id = `stats-${pkg.package_sha256.slice(0, 8)}`;
  return (
    <li className="border-t border-rule-soft first:border-t-0">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full cursor-pointer flex-wrap items-baseline gap-x-5 gap-y-1 py-2 text-left outline-none hover:bg-transparent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        <span aria-hidden>{open ? "›" : "▲"}</span>
        <span className="font-mono font-semibold">{pkg.package_id}</span>
        <span className="font-mono text-subtle">{pkg.package_sha256.slice(0, 4)}…</span>
        <Fig label="Runs" value={String(pkg.runs)} />
        <Fig label="Pass" value={pct(pkg.pass_rate)} />
        <Fig label="Score" value={pkg.mean_score === null ? "—" : pkg.mean_score.toFixed(1)} />
        <Fig label="Median" value={seconds(pkg.median_duration_ms)} />
        <Fig label="Determinism" value={pct(pkg.determinism_rate)} />
        <Fig label="Self-check" value={pct(pkg.self_check_agreement)} />
      </button>
      {open && (
        <ul id={id} className="mb-2 ml-6 border-l border-rule pl-3">
          {pkg.checks.length === 0 && <li className="py-1 text-subtle">No per-check data yet.</li>}
          {pkg.checks.map((c) => (
            <li
              key={c.id}
              className="grid grid-cols-[10rem_8rem_1fr] items-baseline gap-x-3 border-t border-rule-soft py-1 first:border-t-0"
            >
              <span className="font-mono">{c.id}</span>
              <span className="font-mono tabular-nums">
                <span className="text-sm uppercase text-subtle">Fail </span>
                {pct(c.fail_rate)}
              </span>
              <span aria-hidden className="font-mono tracking-widest">
                {glyphBar(c.fail_rate)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

export function StatsBody({ rows }: { rows: PackageStats[] }) {
  const codes = new Map<string, number>();
  for (const r of rows)
    for (const [k, n] of Object.entries(r.withhold_codes)) codes.set(k, (codes.get(k) ?? 0) + n);
  return (
    <div className="grid gap-3">
      <ul className="border-y-2 border-ink">
        {rows.map((r) => (
          <PackageRow key={r.package_sha256} pkg={r} />
        ))}
      </ul>
      <p className="flex flex-wrap items-baseline gap-x-4 border-b border-rule py-2">
        <span className="text-sm font-semibold uppercase tracking-wide">Withhold</span>
        {codes.size === 0 ? (
          <span className="text-subtle">none so far</span>
        ) : (
          [...codes].map(([k, n]) => (
            <span key={k} className="font-mono tabular-nums">
              {k} {n}
            </span>
          ))
        )}
      </p>
    </div>
  );
}

/** Opened by the word STATS or the key `s` (which, like Esc, closes it). Read-only. */
export function StatsPanel() {
  const open = useStatsOpen();
  const q = useQuery({
    queryKey: ["verifier-stats"],
    queryFn: fetchVerifierStats,
    enabled: open,
    refetchInterval: open ? 5000 : false,
    retry: false,
  });
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target;
      const typing =
        t instanceof HTMLElement &&
        (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
      if (e.key === "s" && !e.ctrlKey && !e.metaKey && !e.altKey && !typing) setStatsOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);
  return (
    <Dialog open={open} onOpenChange={setStatsOpen}>
      <DialogContent className="max-w-5xl">
        <DialogHeader>
          <DialogTitle>Stats</DialogTitle>
          <DialogDescription>{STATS_CAPTION}</DialogDescription>
        </DialogHeader>
        <div aria-live="polite">
          {q.isPending && <p className="text-subtle">Loading stats from the verifier.</p>}
          {q.isError && (
            <p role="alert" className="border-y-2 border-ink py-2 font-semibold">
              <span aria-hidden>× </span>The verifier is not reachable. No stats to show.
            </p>
          )}
          {q.data && q.data.length === 0 && (
            <p className="text-subtle">
              No runs recorded yet. Stats appear after the first verdict.
            </p>
          )}
          {q.data && q.data.length > 0 && <StatsBody rows={q.data} />}
        </div>
      </DialogContent>
    </Dialog>
  );
}
