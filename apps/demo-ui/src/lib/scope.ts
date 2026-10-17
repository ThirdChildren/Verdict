import { useMemo } from "react";
import type { AppState, BlockEntry, BudgetView, TaskView } from "../store.js";
import type { MandateRow } from "./mandates.js";

type Links = Pick<AppState, "taskRoots" | "capParents" | "mandates" | "rootHash">;

/** The mandate a task runs under: the ledger's answer, else the live one. Null when nothing is known. */
export const mandateOfTask = (s: Links, id: string): string | null => s.taskRoots[id] ?? s.rootHash;

/** The mandate a blocked attempt belongs to: its child's parent, its own root, else the live one. */
export function mandateOfBlock(s: Links, b: Pick<BlockEntry, "cap_id">): string | null {
  if (b.cap_id) {
    const parent = s.capParents[b.cap_id];
    if (parent) return parent;
    for (const r of s.mandates.values()) if (r.cap_id === b.cap_id) return r.hash;
  }
  return s.rootHash;
}

/** Tasks and blocks of one mandate. Anything with an unknown mandate is kept (nothing to scope it by). */
export function scopeLists(
  s: Pick<AppState, "tasks" | "blocks"> & Links,
  hash: string | null,
): { tasks: Record<string, TaskView>; blocks: BlockEntry[] } {
  if (hash === null) return { tasks: s.tasks, blocks: s.blocks };
  const tasks: Record<string, TaskView> = {};
  for (const [id, t] of Object.entries(s.tasks)) {
    const m = mandateOfTask(s, id);
    if (m === null || m === hash) tasks[id] = t;
  }
  const blocks = s.blocks.filter((b) => {
    const m = mandateOfBlock(s, b);
    return m === null || m === hash;
  });
  return { tasks, blocks };
}

/** Figures of the selected mandate as a budget: live events for the live root, the frozen API figures otherwise. */
export function figuresOf(
  s: Pick<AppState, "budget" | "rootHash">,
  row: MandateRow,
): BudgetView | null {
  if (row.hash === s.rootHash && row.status !== "retired" && s.budget) return s.budget;
  if (!row.figures) return null;
  return {
    cap_id: row.cap_id,
    committed: row.figures.paid,
    reserved: row.figures.locked,
    remaining: row.figures.left,
  };
}

/** Is the selected mandate a frozen one (retired)? Its figures come from the API, not from live events. */
export const isFrozen = (row: MandateRow | undefined): boolean =>
  row !== undefined && (row.status === "retired" || row.retired_at !== null);

/**
 * The state the rail, stage, header ledger and Agents panel read: only the selected mandate's tasks, blocks
 * and figures. `tasks` and `blocks` keep their identity until they really change (a BUDGET_UPDATED or a worker
 * frame does not rebuild them), so everything derived from them can be memoised.
 */
export function useScoped(s: AppState): AppState {
  const { tasks, blocks, taskRoots, capParents, mandates, rootHash, selectedMandate } = s;
  const lists = useMemo(
    () => scopeLists({ tasks, blocks, taskRoots, capParents, mandates, rootHash }, selectedMandate),
    [tasks, blocks, taskRoots, capParents, mandates, rootHash, selectedMandate],
  );
  const row = selectedMandate ? mandates.get(selectedMandate) : undefined;
  const budget = useMemo(
    () => (row ? figuresOf({ budget: s.budget, rootHash }, row) : s.budget),
    [row, s.budget, rootHash],
  );
  return useMemo(
    () => ({ ...s, tasks: lists.tasks, blocks: lists.blocks, budget }),
    [s, lists, budget],
  );
}
