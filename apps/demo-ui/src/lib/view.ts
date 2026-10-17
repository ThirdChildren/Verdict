import type { BlockCode, TaskState } from "@verdict/protocol";
import { z } from "zod";
import type { AppState, TaskView } from "../store.js";
import { BLOCK_TITLES } from "./blocks.js";
import type { Machines } from "./machines.js";
import { FLOW, flowFor } from "./steps.js";

export type Chip =
  | "Working"
  | "Locked"
  | "Verifying"
  | "Refund pending"
  | "Paid"
  | "Refunded"
  | "Expired"
  | "Blocked";

export function chipFor(state: TaskState): Chip {
  switch (state) {
    case "ESCROW_LOCKED":
    case "VERDICT_RELEASE":
    case "APPROVED":
      return "Locked";
    case "DELIVERED":
      return "Verifying";
    case "VERDICT_WITHHOLD":
      return "Refund pending";
    case "CLAIMED":
      return "Paid";
    case "REFUNDED":
      return "Refunded";
    case "EXPIRED":
      return "Expired";
    case "BLOCKED":
      return "Blocked";
    default:
      return "Working";
  }
}

export interface RailRow {
  key: string;
  n: number;
  kind: "task" | "block";
  seq: number;
  label: string;
  amount: string | null;
  chip: Chip;
}

const intentShape = z
  .object({
    amount: z.string().optional(),
    counterparty: z.string().optional(),
    category: z.string().optional(),
    task_spec: z.string().optional(),
  })
  .passthrough();
export type IntentSummary = z.infer<typeof intentShape>;
/** Reads what the agent tried; anything unexpected yields an empty summary (never throws). */
export function intentSummary(intent: unknown): IntentSummary {
  const r = intentShape.safeParse(intent);
  return r.success ? r.data : {};
}

export const shortId = (id: string) => id.replace(/^task_/, "").slice(0, 6);
/** Task description as the engine reports it (contract task spec); a short id until the engine has listed it. */
export const taskLabel = (id: string, descriptions: Record<string, string>) =>
  descriptions[id] ?? `Task ${shortId(id)}`;

/** Rail rows: every task plus every blocked attempt, numbered oldest first, listed newest first. */
export function railRows(
  s: AppState,
  descriptions: Record<string, string> = {},
  stopped: ReadonlySet<string> = new Set(),
): RailRow[] {
  const rows: Omit<RailRow, "n">[] = [];
  for (const [id, t] of Object.entries(s.tasks)) {
    // A task whose only story is a BLOCK is shown by its block row.
    if (t.state === "BLOCKED") continue;
    rows.push({
      key: id,
      kind: "task",
      seq: t.seq,
      label: taskLabel(id, descriptions),
      amount: t.amount,
      chip: stopped.has(id) ? "Refund pending" : chipFor(t.state),
    });
  }
  for (const b of s.blocks) {
    rows.push({
      key: `block:${b.seq}`,
      kind: "block",
      seq: b.seq,
      label: BLOCK_TITLES[b.code as BlockCode],
      amount: intentSummary(b.intent).amount ?? null,
      chip: "Blocked",
    });
  }
  rows.sort((a, b) => a.seq - b.seq);
  return rows.map((r, i) => ({ ...r, n: i + 1 })).reverse();
}

export type StepState = "pending" | "active" | "done" | "failed" | "skipped";
export interface StepView {
  id: string;
  label: string;
  machine: string;
  state: StepState;
  at: string | null;
  /** Replaces the default state word (for example "Waiting for refund"). */
  word?: string;
}

/** The 5-step stage model for one task. `machines` comes from the peers config (lib/machines.ts). */
export function stepViews(t: TaskView, machines: Machines, stopped = false): StepView[] {
  const pos = flowFor(t.state);
  return FLOW.map((f, i) => {
    if (stopped && i >= 2) {
      // The worker vanished: Work is stuck, Verify never runs, Settle waits for the escrow deadline.
      const base = {
        id: f.id,
        label: f.label,
        machine: `${machines[f.role]} · ${f.what}`,
        at: t.stepAt[i] ?? null,
      };
      if (i === 2) return { ...base, state: "failed" as const, word: "Worker stopped responding" };
      if (i === 3)
        return { ...base, state: "skipped" as const, word: "Skipped — nothing delivered" };
      return { ...base, state: "active" as const, word: "Waiting for refund" };
    }
    const state: StepState =
      i === pos.failedStep || (i === 3 && pos.end === "refunded" && t.failAt !== undefined)
        ? "failed"
        : i < pos.active
          ? "done"
          : i === pos.active
            ? pos.failed
              ? "failed"
              : "active"
            : "pending";
    const label =
      i === 4 && pos.end === "refunded"
        ? "Refunded"
        : i === 4 && pos.end === "expired"
          ? "Expired"
          : f.label;
    // A refund that follows a FAIL verdict keeps Verify marked FAIL.
    const failedVerify = i === 3 && pos.end === "refunded" && t.failAt !== undefined;
    const word =
      i === pos.failedStep || failedVerify
        ? "FAIL"
        : i === 4 && pos.failedStep !== undefined
          ? "Waiting for refund"
          : undefined;
    return {
      id: f.id,
      label,
      machine: `${machines[f.role]} · ${f.what}`,
      state,
      at: t.stepAt[i] ?? null,
      ...(word ? { word } : {}),
    };
  });
}
