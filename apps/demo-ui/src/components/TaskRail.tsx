import type { ReactNode } from "react";
import { stoppedIds, useNow } from "../lib/stopped.js";
import { type RailRow, railRows } from "../lib/view.js";
import { type AppState, useStore } from "../store.js";
import { StatusChip } from "./StatusChip.js";
import type { Live } from "./WorkerLane.js";

function Row({ row, selected }: { row: RailRow; selected: boolean }) {
  const select = useStore((s) => s.select);
  return (
    <li className="border-b border-rule-soft">
      <button
        type="button"
        onClick={() => select(row.key)}
        aria-current={selected ? "true" : undefined}
        title={row.label}
        className={`grid h-16 w-full min-w-0 grid-cols-[3ch_minmax(16ch,1fr)_auto] content-center items-baseline gap-x-2 gap-y-0.5 border-l-2 px-2 text-left hover:bg-surface ${selected ? "border-ink bg-surface" : "border-transparent"}`}
      >
        <span className="font-mono text-sm text-subtle">#{row.n}</span>
        <span className="truncate text-base">{row.label}</span>
        <span className="text-right font-mono text-xs whitespace-nowrap">
          {row.amount ? `${row.amount} tUSD` : ""}
        </span>
        <span className="col-span-2 col-start-2 text-left">
          <StatusChip chip={row.chip} />
          {row.retired && <span className="ml-3 text-sm text-subtle">mandate retired</span>}
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
  live?: Live | null;
}) {
  const locked = Object.values(props.state.tasks).some((t) => t.state === "ESCROW_LOCKED");
  const now = useNow(locked);
  const rows = railRows(
    props.state,
    props.descriptions,
    stoppedIds(props.state, now, props.live ?? null),
  );
  const selected = props.state.selected;
  return (
    <div className="flex h-full flex-col gap-4">
      {props.newTask}
      <nav aria-label="Tasks" className="min-h-0 flex-1">
        <div className="h-full overflow-y-auto">
          {rows.length === 0 ? (
            <p className="text-base text-subtle">
              No tasks yet. Start one and it will appear here, newest on top.
            </p>
          ) : (
            <ul className="grid grid-cols-[minmax(0,1fr)] border-t border-rule">
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
