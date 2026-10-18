import { type ReactNode, useMemo } from "react";
import { stoppedIds, useNow } from "../lib/stopped.js";
import { type RailRow, railRows } from "../lib/view.js";
import { type AppState, useStore } from "../store.js";
import { StatusChip } from "./StatusChip.js";
import type { Live } from "./WorkerLane.js";

function Row({ row, selected }: { row: RailRow; selected: boolean }) {
  const select = useStore((s) => s.select);
  return (
    <li>
      <button
        type="button"
        onClick={() => select(row.key)}
        aria-current={selected ? "true" : undefined}
        title={row.label}
        className={`grid min-h-16 w-full min-w-0 grid-cols-[3ch_minmax(0,1fr)] content-center items-baseline gap-x-2 gap-y-1  border px-3 py-2 text-left outline-none transition duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ${selected ? "border-signal/60 bg-card shadow-soft ring-2 ring-signal/15" : "border-transparent hover:border-rule-soft hover:bg-card hover:shadow-soft"}`}
      >
        <span className="font-mono text-sm text-subtle">#{row.n}</span>
        <span className="line-clamp-2 text-base leading-snug">{row.label}</span>
        <span className="col-start-2 flex flex-wrap items-baseline gap-x-3">
          <StatusChip chip={row.chip} />
          {row.amount && (
            <span className="border border-rule-soft bg-card px-1.5 py-0.5 font-mono text-xs whitespace-nowrap">
              {row.amount} tUSD
            </span>
          )}
          {row.retired && <span className="text-sm text-subtle">mandate retired</span>}
        </span>
      </button>
    </li>
  );
}

/** Left rail: the new-task entry point, one row per task or blocked attempt, newest on top. */
export function TaskRail(props: {
  state: AppState;
  descriptions: Record<string, string>;
  newTask: ReactNode;
  /** The mandates list, shown between NEW TASK and the rail. */
  mandates?: ReactNode;
  live?: Live | null;
}) {
  const locked = Object.values(props.state.tasks).some((t) => t.state === "ESCROW_LOCKED");
  const now = useNow(locked);
  const stopped = stoppedIds(props.state, now, props.live ?? null);
  const stoppedKey = [...stopped].sort().join(",");
  // Rebuilt only when the scoped tasks, blocks, descriptions or stopped set change: a budget or worker frame
  // leaves all of them untouched.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `stopped` is covered by `stoppedKey`; the state's other fields do not feed the rows
  const rows = useMemo(
    () => railRows(props.state, props.descriptions, stopped),
    [
      props.state.tasks,
      props.state.blocks,
      props.state.retirements,
      props.descriptions,
      stoppedKey,
    ],
  );
  const selected = props.state.selected;
  return (
    <div className="flex h-full flex-col gap-4">
      {props.newTask}
      {props.mandates}
      <nav aria-label="Tasks" className="min-h-0 flex-1">
        <div className="h-full overflow-y-auto">
          {rows.length === 0 ? (
            <p className="text-base text-subtle">
              No tasks yet. Start one and it will appear here, newest on top.
            </p>
          ) : (
            <ul className="grid grid-cols-[minmax(0,1fr)] gap-1">
              {rows.map((r) => (
                <Row key={r.key} row={r} selected={r.key === selected} />
              ))}
            </ul>
          )}
        </div>
      </nav>
    </div>
  );
}

/** Next/previous row key for j/k navigation (rows are newest first). */
export function neighbour(rows: RailRow[], current: string | null, dir: 1 | -1): string | null {
  if (rows.length === 0) return null;
  const i = rows.findIndex((r) => r.key === current);
  const j = i === -1 ? 0 : Math.min(rows.length - 1, Math.max(0, i + dir));
  return rows[j]?.key ?? null;
}
