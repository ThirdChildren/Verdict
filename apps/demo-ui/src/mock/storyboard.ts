// MOCK DATA: storyboard scenes for UI development only (?mock=1). Each scene is a prefix of the recorded stream
// plus, where needed, a few extra recorded-style events. Everything is validated against the protocol schema.
import { capabilityHash, type TaskState, type UiEvent, uiEventSchema } from "@verdict/protocol";
import type { Live } from "../components/WorkerLane.js";
import type { MockHistory } from "./api.js";
import { MOCK_EVENTS, MOCK_ROOT } from "./events.js";

const TASK = "task_0123456789abcdef";

export interface Scene {
  id: string;
  label: string;
  events: UiEvent[];
  live?: Live;
  /** What GET /api/mandates and GET /api/tasks answer in this scene (reload / history). */
  history?: MockHistory;
}

const upto = (pred: (e: UiEvent) => boolean): UiEvent[] => {
  const i = MOCK_EVENTS.findIndex(pred);
  return MOCK_EVENTS.slice(0, i + 1);
};
const state = (s: TaskState) => (e: UiEvent) => e.type === "TASK_STATE" && e.data.state === s;
const lastSeq = (evs: UiEvent[]) => evs[evs.length - 1]?.seq ?? 0;
/** ISO time `secs` seconds after the last event of a scene (negative: before it). */
const after = (evs: UiEvent[], secs: number): string =>
  new Date(
    Date.parse(evs[evs.length - 1]?.at ?? "2026-10-18T15:52:00Z") + secs * 1000,
  ).toISOString();
const task = (seq: number, s: TaskState, at: string, attempt?: number): UiEvent =>
  uiEventSchema.parse({
    seq,
    at,
    type: "TASK_STATE",
    data: { task_id: TASK, state: s, ...(attempt ? { attempt } : {}) },
  });
const payFailed = (seq: number, at: string): UiEvent =>
  uiEventSchema.parse({
    seq,
    at,
    type: "PAYMENT_STATUS",
    data: { task_id: TASK, payment_hash: "f".repeat(64), status: "Failed" },
  });

/** The last event happened just now, so the "held for more than 10 s" rule has not fired yet. */
const fresh = (evs: UiEvent[]): UiEvent[] =>
  evs.map((e, i) =>
    i === evs.length - 1 ? uiEventSchema.parse({ ...e, at: new Date().toISOString() }) : e,
  );

const ago = (secs: number): string => new Date(Date.now() - secs * 1000).toISOString();

const locked = upto(state("ESCROW_LOCKED"));
const failed = upto(state("VERDICT_WITHHOLD"));
const SAMPLE_LIVE: Live = {
  key: `${TASK}:1`,
  attempt: 1,
  thinking: "",
  output: '[\n  {"name": "Ada", "age": "36"},\n  {"name": "Grace", "age": "45"}\n',
  tokens: 184,
  tps: 41.7,
  done: false,
};

/** Scene 14: mandate 01 (retired, one settled and one refunded task) and mandate 02 (active, one task running). */
const twoMandates = (): Pick<Scene, "events" | "history" | "live"> => {
  const T1 = "task_aaaaaaaaaaaaaaaa";
  const T2 = "task_bbbbbbbbbbbbbbbb";
  const T3 = "task_cccccccccccccccc";
  const A = "cap_aaaaaaaaaaaaaaaa";
  const B = "cap_bbbbbbbbbbbbbbbb";
  const t0 = Date.now() - 3 * 3600_000;
  const iso = (secs: number) => new Date(t0 + secs * 1000).toISOString();
  let seq = 0;
  const ev = (type: string, secs: number, data: unknown): UiEvent =>
    uiEventSchema.parse({ seq: seq++, at: iso(secs), type, data });
  const root = (cap_id: string, hours: number) => ({
    ...MOCK_ROOT,
    cap_id,
    expires_at: new Date(t0 + hours * 3600_000).toISOString().replace(/\.\d{3}Z$/, "Z"),
  });
  const rootA = root(A, 12);
  const rootB = root(B, 12.2);
  const budget = (cap: string, remaining: string, reserved: string, committed: string, s: number) =>
    ev("BUDGET_UPDATED", s, { cap_id: cap, remaining, reserved, committed });
  const st = (id: string, state: TaskState, s: number) =>
    ev("TASK_STATE", s, { task_id: id, state });
  const pay = (id: string, hash: string, status: string, s: number) =>
    ev("PAYMENT_STATUS", s, { task_id: id, payment_hash: hash, status });
  const hashOf = (r: ReturnType<typeof root>) => {
    const e = uiEventSchema.parse({ seq: 0, at: iso(0), type: "CAP_ROOT", data: r });
    if (e.type !== "CAP_ROOT") throw new Error("root");
    return capabilityHash(e.data);
  };
  const [hA, hB] = [hashOf(rootA), hashOf(rootB)];
  const childTpl = MOCK_EVENTS.find((e) => e.type === "CAP_CHILD");
  if (childTpl?.type !== "CAP_CHILD") throw new Error("mock child missing");
  const child = (cap: string, parent: string, amount: string, s: number) =>
    ev("CAP_CHILD", s, { ...childTpl.data, cap_id: cap, parent, max_total: amount });
  const events: UiEvent[] = [
    ev("CAP_ROOT", 0, rootA),
    budget(A, "5.00", "0.00", "0.00", 1),
    child("cap_1111111111111111", hA, "1.20", 59),
    st(T1, "ESCROW_LOCKED", 60),
    pay(T1, "1".repeat(64), "Pending", 61),
    pay(T1, "1".repeat(64), "Settled", 120),
    st(T1, "CLAIMED", 121),
    budget(A, "3.80", "0.00", "1.20", 122),
    child("cap_2222222222222222", hA, "1.00", 199),
    st(T2, "ESCROW_LOCKED", 200),
    pay(T2, "2".repeat(64), "Failed", 260),
    st(T2, "REFUNDED", 261),
    budget(A, "3.80", "0.00", "1.20", 262),
    ev("CAP_ROOT", 600, rootB),
    budget(B, "5.00", "0.00", "0.00", 601),
    child("cap_3333333333333333", hB, "1.20", 699),
    st(T3, "ESCROW_LOCKED", 700),
    pay(T3, "3".repeat(64), "Pending", 701),
    budget(B, "3.80", "1.20", "0.00", 702),
  ];
  const counts = (total: number, settled: number, refunded: number, in_flight: number) => ({
    total,
    settled,
    refunded,
    blocked: 0,
    in_flight,
  });
  const history: MockHistory = {
    mandates: {
      mandates: [
        {
          cap_id: B,
          hash: hB,
          status: "active",
          ceiling: "5.00",
          per_task: "2.00",
          expires_at: rootB.expires_at,
          created_at: iso(600),
          retired_at: null,
          figures: { paid: "0.00", locked: "1.20", left: "3.80" },
          tasks: counts(1, 0, 0, 1),
        },
        {
          cap_id: A,
          hash: hA,
          status: "retired",
          ceiling: "5.00",
          per_task: "2.00",
          expires_at: rootA.expires_at,
          created_at: iso(0),
          retired_at: iso(600),
          figures: { paid: "1.20", locked: "0.00", left: "3.80" },
          tasks: counts(2, 1, 1, 0),
        },
      ],
    },
    tasks: [
      {
        task_id: T3,
        description: "Convert the March invoices CSV into JSON",
        amount: "1.20",
        root_hash: hB,
      },
      {
        task_id: T2,
        description: "Convert the price list CSV into JSON",
        amount: "1.20",
        root_hash: hA,
      },
      { task_id: T1, description: "Convert a CSV file into JSON", amount: "1.20", root_hash: hA },
    ],
  };
  return {
    events,
    history,
    live: { ...SAMPLE_LIVE, key: `${T3}:1` },
  };
};

export const SCENES: Scene[] = [
  { id: "empty", label: "1 · No mandate", events: [] },
  { id: "authorized", label: "2 · Authorized", events: upto(state("ACCEPTED")) },
  { id: "working", label: "3 · Funds locked, worker typing", events: locked, live: SAMPLE_LIVE },
  { id: "verify-fail", label: "4 · Verify FAIL", events: fresh(failed) },
  { id: "verify-pass", label: "5 · Verify PASS", events: upto(state("VERDICT_RELEASE")) },
  { id: "settled", label: "6 · Settled", events: upto(state("CLAIMED")) },
  {
    id: "fail-refunded",
    label: "7 · Verify FAIL, refunded",
    // Honest worker: it cancelled right after the FAIL, so the refund came within seconds.
    events: [
      ...failed,
      payFailed(lastSeq(failed) + 1, after(failed, 3)),
      task(lastSeq(failed) + 2, "REFUNDED", after(failed, 4)),
    ],
  },
  {
    id: "refunded",
    label: "8 · Refunded (worker never claimed)",
    events: [
      ...locked,
      payFailed(lastSeq(locked) + 1, after(locked, 20)),
      task(lastSeq(locked) + 2, "REFUNDED", after(locked, 21)),
    ],
  },
  {
    id: "expired",
    label: "9 · Expired",
    events: [...locked, task(lastSeq(locked) + 1, "EXPIRED", after(locked, 30))],
  },
  {
    id: "ring",
    label: "10 · Worker disappears (stopped, block ring)",
    // The worker accepted and the funds locked; nothing came back for a minute: no tokens, no delivery, no verdict.
    events: [
      ...locked.slice(0, -1),
      ...locked.slice(-1).map((e) => uiEventSchema.parse({ ...e, at: ago(60) })),
    ],
  },
  { id: "blocked", label: "11 · Blocked attempt", events: MOCK_EVENTS },
  // The settled task under the first mandate; open NEW MANDATE in the header to sign the second one.
  {
    id: "second-mandate",
    label: "13 · Second mandate (open NEW MANDATE in the header)",
    events: upto(state("CLAIMED")),
  },
  { id: "mandates-history", label: "14 · Two mandates (history)", ...twoMandates() },
];
export const PLAY = "play";
