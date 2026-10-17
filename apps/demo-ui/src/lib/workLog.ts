import type { UiEvent } from "@verdict/protocol";
import { BLOCK_TITLES } from "./blocks.js";
import { PAYMENT_CAPTIONS, TASK_CAPTIONS, VERDICT_CAPTIONS } from "./captions.js";

export type LogAgent = "ENGINE" | "BUYER" | "WORKER" | "VERIFIER";
export interface LogRow {
  key: string;
  at: string;
  agent: LogAgent;
  text: string;
}

const STATE_AGENT: Record<string, LogAgent> = {
  OFFERED: "BUYER",
  ACCEPTED: "WORKER",
  DELIVERED: "WORKER",
  CLAIMED: "WORKER",
  P_DEPOSITED: "VERIFIER",
  P_CONFIRMED: "VERIFIER",
  VERDICT_RELEASE: "VERIFIER",
  VERDICT_WITHHOLD: "VERIFIER",
};

/** One plain sentence per engine event, or null when the event is not worth a line. */
export function logRow(e: UiEvent): LogRow | null {
  const row = (agent: LogAgent, text: string): LogRow => ({
    key: `${e.seq}`,
    at: e.at,
    agent,
    text,
  });
  switch (e.type) {
    case "TASK_STATE": {
      const att = e.data.attempt ? ` (attempt ${e.data.attempt})` : "";
      return row(STATE_AGENT[e.data.state] ?? "ENGINE", `${TASK_CAPTIONS[e.data.state]}${att}`);
    }
    case "PAYMENT_STATUS":
      return row("ENGINE", PAYMENT_CAPTIONS[e.data.status]);
    case "VERDICT":
      return row("VERIFIER", `${VERDICT_CAPTIONS[e.data.verdict]} (attempt ${e.data.attempt})`);
    case "REFUNDED":
      return row("ENGINE", "The funds are back in your budget.");
    case "CLAIMED":
      return row("WORKER", "The worker collected the payment.");
    case "BLOCKED":
      return row("ENGINE", `Blocked: ${BLOCK_TITLES[e.data.code]}. ${e.data.message}`);
    default:
      return null;
  }
}

/** Oldest first. `events` is the newest-first list for the selection (eventsFor). */
export function workLog(events: readonly UiEvent[], extra: readonly LogRow[] = []): LogRow[] {
  const rows = [...events].reverse().flatMap((e) => logRow(e) ?? []);
  return [...rows, ...extra].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}
