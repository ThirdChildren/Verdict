import type {
  BlockCode,
  ChildCapability,
  PaymentStatus,
  RootCapability,
  TaskState,
  UiEvent,
  VerdictRecord,
} from "@verdict/protocol";
import { capabilityHash } from "@verdict/protocol";
import { create } from "zustand";
import type { MandateRow } from "./lib/mandates.js";
import type { MineProgress } from "./lib/mine.js";
import { precisionOf } from "./lib/money.js";
import type { MandateRetired } from "./lib/retired.js";
import { mandateOfBlock, scopeLists } from "./lib/scope.js";
import { flowFor, stepForState } from "./lib/steps.js";
import { workerStoppedHint } from "./lib/stopped.js";
import { railRows } from "./lib/view.js";

export type Service = "engine" | "worker" | "verifier";
export type ConnStatus = "connecting" | "connected" | "disconnected" | "mock";

export interface BlockEntry {
  seq: number;
  at: string;
  code: BlockCode;
  message: string;
  cap_id: string | null;
  /** What the agent tried, as the engine reported it (shape not guaranteed: parse before use). */
  intent: unknown;
}
export interface PaymentStep {
  status: PaymentStatus;
  /** `at` of the PAYMENT_STATUS event. */
  at: string;
}
export interface TaskView {
  state: TaskState;
  /** Task amount in tUSD (max_total of the child capability derived for it), null until known. */
  amount: string | null;
  paymentHash: string | null;
  /** One entry per status change, in arrival order. */
  payHistory: PaymentStep[];
  attempt: number;
  /** Active step index (STEPS.length = all done). Kept across BLOCKED. */
  step: number;
  blocked: boolean;
  /** seq of the first event of this task (orders the rail). */
  seq: number;
  /** Time each stage of the 5-step flow was first reached, by index (screen-only). */
  stepAt: Record<number, string>;
  /** When the FAIL verdict arrived (screen-only); drives the "still held" ring rule. */
  failAt?: string;
  /** Backend hint that the worker stopped (true) or works (false); absent: derive it from silence. */
  workerStopped?: boolean;
}
export interface BudgetView {
  cap_id: string;
  remaining: string;
  reserved: string;
  committed: string;
}
/** A mandate replaced by a new one (engine MANDATE_RETIRED). Tasks started up to `afterSeq` ran under it. */
export interface Retirement extends MandateRetired {
  afterSeq: number;
  receivedAt: string;
}
/** The principal as the console knows it. Kept for the session: a reset of the event stream does not disconnect it. */
export type PrincipalState =
  | { status: "disconnected" }
  | { status: "connecting" }
  | { status: "connected"; id: string }
  | { status: "error"; message: string };

export interface AppState {
  /** Budget of the ROOT mandate: covers all tasks. */
  budget: BudgetView | null;
  /** Budget of each child capability, by cap_id. */
  childBudgets: Record<string, BudgetView>;
  /** Worker display names from the signed mandate, by payee id (screen-only; absent after a reload). */
  payeeNames: Record<string, string>;
  lastSeq: number;
  rejectedFrames: number;
  root: RootCapability | null;
  child: ChildCapability | null;
  precision: number;
  tasks: Record<string, TaskView>;
  currentTask: string | null;
  payments: Record<string, string>;
  verdicts: VerdictRecord[];
  blocks: BlockEntry[];
  refunded: string[];
  /** Payments sent whose outcome the wallet has not reported yet (engine PAYMENT_CONFIRMING). */
  confirming: string[];
  claimed: string[];
  connections: Record<Service, ConnStatus>;
  /** Raw engine events, newest first, capped (Inspector > Events). */
  events: UiEvent[];
  /** Rail selection: a task id or `block:<seq>`. Screen-only. */
  selected: string | null;
  /** Live "Mine until refund" progress by task id (engine DEMO_MINE_PROGRESS). */
  mine: Record<string, MineProgress>;
  /** Retired mandates, newest first (engine MANDATE_RETIRED, outside the protocol event stream). */
  retirements: Retirement[];
  /** Every mandate seen, by root hash (rebuilt from the API on connect, then kept current by events). Never mutated. */
  mandates: Map<string, MandateRow>;
  /** The mandate whose tasks and figures the screen shows (root hash). */
  selectedMandate: string | null;
  /** Hash of the live (newest) root, computed from its CAP_ROOT event. */
  rootHash: string | null;
  /** Task id -> root hash. The ledger's answer (API) wins over what events implied. */
  taskRoots: Record<string, string>;
  /** Child capability id -> parent root hash (from CAP_CHILD). */
  capParents: Record<string, string>;
  principal: PrincipalState;
}

export const initialState: AppState = {
  budget: null,
  childBudgets: {},
  payeeNames: {},
  lastSeq: -1,
  rejectedFrames: 0,
  root: null,
  child: null,
  precision: 2,
  tasks: {},
  currentTask: null,
  payments: {},
  verdicts: [],
  blocks: [],
  refunded: [],
  confirming: [],
  claimed: [],
  connections: { engine: "connecting", worker: "connecting", verifier: "connecting" },
  events: [],
  selected: null,
  mine: {},
  retirements: [],
  mandates: new Map(),
  selectedMandate: null,
  rootHash: null,
  taskRoots: {},
  capParents: {},
  principal: { status: "disconnected" },
};

const lazyRow = (hash: string, order: number): MandateRow => ({
  hash,
  cap_id: "",
  status: "active",
  ceiling: "",
  per_task: "",
  expires_at: "",
  created_at: null,
  retired_at: null,
  figures: null,
  tasks: null,
  order,
});
const nextOrder = (m: Map<string, MandateRow>) =>
  Math.max(0, ...[...m.values()].map((r) => r.order)) + 1;

/** Marks a mandate retired and freezes the figures the screen last had for it. */
function freeze(row: MandateRow, s: AppState, at: string): MandateRow {
  if (row.status === "retired" && row.figures) return row;
  const b = s.budget && s.budget.cap_id === row.cap_id ? s.budget : null;
  return {
    ...row,
    status: "retired",
    retired_at: row.retired_at ?? at,
    figures: b ? { paid: b.committed, locked: b.reserved, left: b.remaining } : row.figures,
  };
}

function blank(s: AppState, prev: TaskView | undefined, seq = 0): TaskView {
  return (
    prev ?? {
      state: "DRAFT",
      amount: s.child?.max_total ?? null,
      paymentHash: null,
      payHistory: [],
      attempt: 1,
      step: 0,
      blocked: false,
      seq,
      stepAt: {},
    }
  );
}

/** Records when each stage of the 5-step flow was first reached. */
function stampSteps(prev: Record<number, string>, state: TaskState, at: string) {
  const pos = flowFor(state);
  const out = { ...prev };
  // After a failed check the money waits at Settle, but Settle has not really happened: do not stamp it.
  const upTo = pos.failedStep !== undefined ? pos.failedStep : Math.min(pos.active, 4);
  for (let i = 0; i <= upTo; i++) out[i] ??= at;
  if (pos.active === 5) out[4] = at;
  return out;
}

export const EVENT_LOG_MAX = 400;
export const blockKey = (seq: number) => `block:${seq}`;

/** Pure event -> state reducer. Events with an old seq are ignored (replay safe). */
export function reduce(s: AppState, e: UiEvent): AppState {
  if (e.seq <= s.lastSeq) return s;
  const next: AppState = {
    ...s,
    lastSeq: e.seq,
    // Worker tokens arrive on their own socket in bursts; they are not protocol messages worth keeping.
    events: e.type === "WORKER_STREAM" ? s.events : [e, ...s.events].slice(0, EVENT_LOG_MAX),
  };
  switch (e.type) {
    case "CAP_ROOT": {
      // A different root is a new mandate: its numbers arrive with its own BUDGET_UPDATED, never the old ones.
      const hash = capabilityHash(e.data);
      const mandates = new Map(s.mandates);
      const prevLive = s.rootHash && s.rootHash !== hash ? mandates.get(s.rootHash) : undefined;
      if (prevLive) mandates.set(prevLive.hash, freeze(prevLive, s, e.at));
      const known = mandates.get(hash);
      mandates.set(hash, {
        ...(known ?? lazyRow(hash, nextOrder(mandates))),
        cap_id: e.data.cap_id,
        status: known?.status === "retired" ? "retired" : "active",
        ceiling: e.data.max_total,
        per_task: e.data.max_per_task ?? "",
        expires_at: e.data.expires_at,
        created_at: known?.created_at ?? e.at,
      });
      return {
        ...next,
        root: e.data,
        rootHash: hash,
        mandates,
        // A new root is selected on creation (the old one stays in the list, read-only).
        selectedMandate: hash,
        selected: s.selectedMandate === hash ? s.selected : null,
        precision: precisionOf(e.data.max_total),
        budget: s.root && s.root.cap_id !== e.data.cap_id ? null : s.budget,
      };
    }
    case "CAP_CHILD":
      return {
        ...next,
        child: e.data,
        capParents: { ...s.capParents, [e.data.cap_id]: e.data.parent },
      };
    case "BLOCKED": {
      const cur = s.currentTask ? s.tasks[s.currentTask] : undefined;
      return {
        ...next,
        blocks: [
          {
            seq: e.seq,
            at: e.at,
            code: e.data.code,
            message: e.data.message,
            cap_id: e.data.cap_id,
            intent: e.data.intent,
          },
          ...s.blocks,
        ],
        selected: blockKey(e.seq),
        selectedMandate: mandateOfBlock(s, e.data) ?? s.selectedMandate,
        tasks: cur ? { ...s.tasks, [s.currentTask as string]: { ...cur, blocked: true } } : s.tasks,
      };
    }
    case "TASK_STATE": {
      const prev = s.tasks[e.data.task_id];
      // A task's mandate is fixed when it is first seen: the live root (only it can start tasks).
      const home = prev ? null : (s.rootHash ?? s.child?.parent ?? null);
      const links =
        home && !s.taskRoots[e.data.task_id]
          ? {
              taskRoots: { ...s.taskRoots, [e.data.task_id]: home },
              mandates: s.mandates.has(home)
                ? s.mandates
                : new Map(s.mandates).set(home, lazyRow(home, nextOrder(s.mandates))),
            }
          : {};
      if (e.data.state === "BLOCKED") {
        const view: TaskView = {
          ...blank(s, prev, e.seq),
          state: "BLOCKED",
          attempt: prev?.attempt ?? 1,
          step: prev?.step ?? 0,
          blocked: true,
        };
        return {
          ...next,
          ...links,
          currentTask: e.data.task_id,
          tasks: { ...s.tasks, [e.data.task_id]: view },
        };
      }
      const step = stepForState(e.data.state);
      const view: TaskView = {
        ...blank(s, prev, e.seq),
        amount: prev?.amount ?? s.child?.max_total ?? null,
        stepAt: stampSteps(prev?.stepAt ?? {}, e.data.state, e.at),
        state: e.data.state,
        attempt: e.data.attempt ?? prev?.attempt ?? 1,
        step,
        blocked: false,
        ...(e.data.state === "VERDICT_WITHHOLD" && prev?.state !== "VERDICT_WITHHOLD"
          ? { failAt: e.at }
          : {}),
        ...(workerStoppedHint(e.data) !== undefined
          ? { workerStopped: workerStoppedHint(e.data) as boolean }
          : {}),
      };
      return {
        ...next,
        ...links,
        currentTask: e.data.task_id,
        tasks: { ...s.tasks, [e.data.task_id]: view },
        selected: prev ? s.selected : e.data.task_id,
        selectedMandate: prev ? s.selectedMandate : (home ?? s.selectedMandate),
      };
    }
    case "PAYMENT_STATUS": {
      const h = e.data.payment_hash;
      const payments = { ...s.payments, [h]: e.data.status };
      const tid = e.data.task_id;
      const t = s.tasks[tid] ?? blank(s, undefined, e.seq);
      const last = t.payHistory[t.payHistory.length - 1];
      const tasks: Record<string, TaskView> = {
        ...s.tasks,
        [tid]: {
          ...t,
          paymentHash: h,
          payHistory:
            last?.status === e.data.status
              ? t.payHistory
              : [...t.payHistory, { status: e.data.status, at: e.at }],
        },
      };
      return { ...next, payments, tasks, confirming: s.confirming.filter((x) => x !== h) };
    }
    case "PAYMENT_CONFIRMING":
      return {
        ...next,
        confirming: s.confirming.includes(e.data.payment_hash)
          ? s.confirming
          : [...s.confirming, e.data.payment_hash],
      };
    case "REFUNDED": {
      return { ...next, refunded: [...s.refunded, e.data.payment_hash] };
    }
    case "BUDGET_UPDATED": {
      // Root and child capabilities each report their own budget. Before the root is known, accept the event.
      const isRoot = s.root ? e.data.cap_id === s.root.cap_id : true;
      return isRoot
        ? { ...next, budget: e.data }
        : { ...next, childBudgets: { ...s.childBudgets, [e.data.cap_id]: e.data } };
    }
    case "CLAIMED":
      return { ...next, claimed: [...s.claimed, e.data.payment_hash] };
    case "VERDICT":
      return { ...next, verdicts: [...s.verdicts, e.data] };
    case "WORKER_STREAM":
      // Arrives on the worker's own socket and is shown by WorkerLane; nothing to keep in the engine state.
      return next;
  }
}

interface Actions {
  apply: (e: UiEvent) => void;
  reject: () => void;
  setConnection: (svc: Service, st: ConnStatus) => void;
  setPayeeNames: (names: Record<string, string>) => void;
  select: (key: string) => void;
  setMine: (p: MineProgress) => void;
  retire: (r: MandateRetired) => void;
  /** Rebuilds the mandate map and the task -> mandate links from the API (newest mandate first). */
  hydrate: (rows: MandateRow[], taskRoots: Record<string, string>) => void;
  selectMandate: (hash: string) => void;
  setPrincipal: (p: PrincipalState) => void;
  reset: () => void;
}
export const useStore = create<AppState & Actions>((set) => ({
  ...initialState,
  apply: (e) => set((s) => reduce(s, e)),
  reject: () => set((s) => ({ rejectedFrames: s.rejectedFrames + 1 })),
  setConnection: (svc, st) => set((s) => ({ connections: { ...s.connections, [svc]: st } })),
  setPayeeNames: (names) => set({ payeeNames: names }),
  select: (key) => set({ selected: key }),
  setMine: (p) => set((s) => ({ mine: { ...s.mine, [p.task_id]: p } })),
  retire: (r) =>
    set((s) => {
      const mandates = new Map(s.mandates);
      const at = r.at ?? new Date().toISOString();
      for (const id of r.retired) {
        const row = mandates.get(id) ?? [...mandates.values()].find((m) => m.cap_id === id);
        if (row) mandates.set(row.hash, freeze(row, s, at));
      }
      return {
        mandates,
        retirements: [
          { ...r, afterSeq: s.lastSeq, receivedAt: r.at ?? new Date().toISOString() },
          ...s.retirements,
        ],
      };
    }),
  hydrate: (rows, taskRoots) =>
    set((s) => {
      const mandates = new Map<string, MandateRow>();
      for (const r of rows) {
        const live = s.mandates.get(r.hash);
        mandates.set(r.hash, live?.status === "retired" ? { ...r, status: "retired" } : r);
      }
      let order = Math.max(0, ...rows.map((r) => r.order));
      for (const r of [...s.mandates.values()].sort((a, b) => a.order - b.order))
        if (!mandates.has(r.hash)) mandates.set(r.hash, { ...r, order: ++order });
      const first = [...mandates.values()].sort((a, b) => b.order - a.order);
      const pick =
        s.selectedMandate && mandates.has(s.selectedMandate)
          ? s.selectedMandate
          : ((first.find((r) => r.status === "active") ?? first[0])?.hash ?? null);
      return {
        mandates,
        taskRoots: { ...s.taskRoots, ...taskRoots },
        selectedMandate: pick,
      };
    }),
  selectMandate: (hash) =>
    set((s) => {
      const lists = scopeLists({ ...s }, hash);
      const top = railRows({ ...s, ...lists })[0]?.key ?? null;
      return { selectedMandate: hash, selected: top };
    }),
  setPrincipal: (principal) => set({ principal }),
  reset: () => set((s) => ({ ...initialState, principal: s.principal })),
}));
