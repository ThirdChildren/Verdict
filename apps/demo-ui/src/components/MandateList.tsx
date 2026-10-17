import { useEffect, useMemo, useState } from "react";
import {
  clockHm,
  leftText,
  type MandateRow,
  type MandateStatus,
  rowStatus,
  taskWord,
} from "../lib/mandates.js";
import { mandateOfTask } from "../lib/scope.js";
import { useStore } from "../store.js";

const GLYPH: Record<MandateStatus, string> = { active: "■", retired: "□", expired: "▲" };

/** Mandates newest first. */
export const sortedMandates = (m: ReadonlyMap<string, MandateRow>): MandateRow[] =>
  [...m.values()].sort((a, b) => b.order - a.order);

/** Next/previous mandate hash for the `[` and `]` keys (rows are newest first; `]` goes down the list). */
export function mandateNeighbour(
  rows: MandateRow[],
  current: string | null,
  dir: 1 | -1,
): string | null {
  if (rows.length === 0) return null;
  const i = rows.findIndex((r) => r.hash === current);
  const j = i === -1 ? 0 : Math.min(rows.length - 1, Math.max(0, i + dir));
  return rows[j]?.hash ?? null;
}

/** How many tasks the screen knows under each mandate: what it saw live, or the API total if larger. */
export function taskCounts(
  tasks: Record<string, unknown>,
  s: Parameters<typeof mandateOfTask>[0],
  rows: MandateRow[],
): Map<string, number> {
  const live = new Map<string, number>();
  for (const id of Object.keys(tasks)) {
    const m = mandateOfTask(s, id);
    if (m) live.set(m, (live.get(m) ?? 0) + 1);
  }
  return new Map(rows.map((r) => [r.hash, Math.max(live.get(r.hash) ?? 0, r.tasks?.total ?? 0)]));
}

function detail(r: MandateRow, st: MandateStatus, now: number): string {
  const ceiling = r.ceiling || "—";
  if (st === "retired") return `${clockHm(r.retired_at)} · ${ceiling}`;
  if (st === "expired") return `${clockHm(r.expires_at)} · ${ceiling}`;
  const perTask = r.per_task ? ` · ${r.per_task}/task` : "";
  return `${ceiling}${perTask} · ${r.expires_at ? leftText(r.expires_at, now) : "—"}`;
}

/** The mandates, newest first, one ruled row each. The selected one scopes the rail, stage and ledger. */
export function MandateList() {
  const mandates = useStore((s) => s.mandates);
  const selected = useStore((s) => s.selectedMandate);
  const tasks = useStore((s) => s.tasks);
  const taskRoots = useStore((s) => s.taskRoots);
  const rootHash = useStore((s) => s.rootHash);
  const select = useStore((s) => s.selectMandate);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  const rows = useMemo(() => sortedMandates(mandates), [mandates]);
  const counts = useMemo(
    () => taskCounts(tasks, { taskRoots, rootHash, mandates, capParents: {} }, rows),
    [tasks, taskRoots, rootHash, mandates, rows],
  );
  return (
    <nav aria-label="Mandates">
      <h2 className="border-b border-ink pb-1 text-xs font-semibold tracking-wide uppercase">
        Mandates
      </h2>
      {rows.length === 0 ? (
        <p className="pt-2 text-sm text-subtle">No mandate yet.</p>
      ) : (
        <ul className="max-h-[9.75rem] overflow-y-auto">
          {rows.map((r) => {
            const st = rowStatus(r, now);
            const isSel = r.hash === selected;
            const n = counts.get(r.hash) ?? 0;
            return (
              <li key={r.hash} className="border-b border-rule-soft">
                <button
                  type="button"
                  onClick={() => select(r.hash)}
                  aria-current={isSel ? "true" : undefined}
                  title={`Mandate ${String(r.order).padStart(2, "0")}, ${st}`}
                  className={`grid min-h-[3.25rem] w-full min-w-0 grid-cols-[2.5ch_minmax(0,1fr)] content-center items-baseline gap-x-2 border-l-2 px-2 py-1 text-left outline-none hover:bg-surface focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring ${isSel ? "border-ink bg-surface" : "border-transparent"}`}
                >
                  <span className="font-mono text-sm text-subtle">
                    {String(r.order).padStart(2, "0")}
                  </span>
                  <span className="flex flex-wrap items-baseline justify-between gap-x-2">
                    <span className="text-sm font-semibold tracking-wide uppercase">
                      <span aria-hidden>{GLYPH[st]} </span>
                      {st.toUpperCase()}
                    </span>
                    <span className="font-mono text-xs whitespace-nowrap">{taskWord(n)}</span>
                  </span>
                  <span className="col-start-2 font-mono text-xs break-words">
                    {detail(r, st, now)}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </nav>
  );
}
