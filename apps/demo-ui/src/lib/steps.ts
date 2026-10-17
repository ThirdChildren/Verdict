import type { TaskState } from "@verdict/protocol";

export const STEPS = [
  {
    id: "mandate",
    label: "Mandate",
    machine: "Legion · engine",
    explain:
      "You set the rules: how much an agent may spend, on what, and until when. You sign them once.",
  },
  {
    id: "contract",
    label: "Contract",
    machine: "Legion · buyer + worker",
    explain:
      "The buyer agent and the worker agree on one task, one price and one automatic test, and both sign it.",
  },
  {
    id: "escrow",
    label: "Escrow",
    machine: "Legion · wallet",
    explain:
      "The money is locked in a Lightning escrow. The worker can see it is there but cannot take it yet.",
  },
  {
    id: "work",
    label: "Work",
    machine: "Legion · worker",
    explain:
      "The worker's local AI model builds the deliverable. It is paid for the result, not for trying.",
  },
  {
    id: "verify",
    label: "Verify",
    machine: "Mac · verifier",
    explain:
      "A separate computer runs a fixed test on the delivery. The same delivery always gives the same answer.",
  },
  {
    id: "payment",
    label: "Payment",
    machine: "Legion · wallet",
    explain: "The test passed (or you approved), so the escrow unlocks and the worker is paid.",
  },
] as const;

/** Index of the step that is currently active; STEPS.length means everything is done. */
export function stepForState(s: TaskState): number {
  switch (s) {
    case "DRAFT":
      return 0;
    case "MANDATE_SIGNED":
    case "CHILD_DERIVED":
    case "OFFERED":
    case "ACCEPTED":
      return 1;
    case "P_DEPOSITED":
    case "P_CONFIRMED":
    case "INVOICE_RECEIVED":
      return 2;
    case "ESCROW_LOCKED":
      return 3;
    case "DELIVERED":
    case "VERDICT_WITHHOLD":
    case "EXPIRED":
      return 4;
    case "VERDICT_RELEASE":
    case "APPROVED":
      return 5;
    case "CLAIMED":
      return STEPS.length;
    case "REFUNDED":
      return 4;
    case "BLOCKED":
      return -1; // caller keeps the previous step
  }
}

/** The 5-step story shown on the stage. `role` picks the machine label (lib/machines.ts) from the peers config. */
export const FLOW = [
  { id: "authorized", label: "Authorized", role: "engine", what: "engine" },
  { id: "locked", label: "Funds locked", role: "engine", what: "wallet" },
  { id: "work", label: "Work", role: "worker", what: "worker" },
  { id: "verify", label: "Verify", role: "verifier", what: "verifier" },
  { id: "settled", label: "Settled", role: "engine", what: "wallet" },
] as const;

export interface FlowPos {
  /** Index of the active step; FLOW.length = everything done. */
  active: number;
  /** The active step needs attention (failed check, refund, expiry). */
  failed: boolean;
  end: "settled" | "refunded" | "expired" | null;
  /** An earlier step that finished with a FAIL while the money still waits (Verify FAIL, Settle waits for the refund). */
  failedStep?: number;
}

export function flowFor(s: TaskState): FlowPos {
  const at = (active: number, failed = false, end: FlowPos["end"] = null): FlowPos => ({
    active,
    failed,
    end,
  });
  switch (s) {
    case "DRAFT":
    case "MANDATE_SIGNED":
    case "CHILD_DERIVED":
    case "OFFERED":
    case "ACCEPTED":
    case "P_DEPOSITED":
    case "P_CONFIRMED":
    case "BLOCKED":
      return at(0);
    case "INVOICE_RECEIVED":
      return at(1);
    case "ESCROW_LOCKED":
      return at(2);
    case "DELIVERED":
      return at(3);
    case "VERDICT_WITHHOLD":
      return { ...at(4), failedStep: 3 };
    case "VERDICT_RELEASE":
    case "APPROVED":
      return at(4);
    case "CLAIMED":
      return at(FLOW.length, false, "settled");
    case "EXPIRED":
      return at(4, true, "expired");
    case "REFUNDED":
      return at(4, true, "refunded");
  }
}
