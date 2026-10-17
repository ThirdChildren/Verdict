import type { ReactNode } from "react";
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
        className={`grid w-full min-w-0 grid-cols-[minmax(0,1fr)] gap-2 rounded-lg p-2 text-left hover:bg-muted ${selected ? "bg-secondary" : ""}`}
      >
        <span className="flex items-baseline gap-2">
          <span className="text-sm tabular-nums text-muted-foreground">#{row.n}</span>
          <span className="truncate text-base">{row.label}</span>
        </span>
        <span className="flex items-center justify-between gap-2">
          <StatusChip chip={row.chip} />
          <span className="text-sm tabular-nums">{row.amount ? `${row.amount} tUSD` : ""}</span>
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
            <p className="text-base text-muted-foreground">
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
