// MOCK DATA: storyboard scenes for UI development only (?mock=1). Each scene is a prefix of the recorded stream
// plus, where needed, a few extra recorded-style events. Everything is validated against the protocol schema.
import { type TaskState, type UiEvent, uiEventSchema } from "@verdict/protocol";
import type { Live } from "../components/WorkerLane.js";
import { MOCK_EVENTS } from "./events.js";

const TASK = "task_0123456789abcdef";

export interface Scene {
  id: string;
  label: string;
  events: UiEvent[];
  live?: Live;
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
  output: '[\n  {"name": "Ada", "age": 36},\n  {"name": "Grace", "age": 45}\n',
  tokens: 184,
  tps: 41.7,
  done: false,
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
  { id: "second-mandate", label: "13 · Second mandate", events: upto(state("CLAIMED")) },
];
export const PLAY = "play";
