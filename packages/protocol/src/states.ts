export const TASK_STATES = [
  "DRAFT",
  "MANDATE_SIGNED",
  "CHILD_DERIVED",
  "OFFERED",
  "ACCEPTED",
  "P_DEPOSITED",
  "P_CONFIRMED",
  "INVOICE_RECEIVED",
  "ESCROW_LOCKED",
  "DELIVERED",
  "VERDICT_RELEASE",
  "VERDICT_WITHHOLD",
  "APPROVED",
  "CLAIMED",
  "EXPIRED",
  "REFUNDED",
  "BLOCKED",
] as const;
export type TaskState = (typeof TASK_STATES)[number];

const PRE_PAYMENT: TaskState[] = [
  "DRAFT",
  "MANDATE_SIGNED",
  "CHILD_DERIVED",
  "OFFERED",
  "ACCEPTED",
  "P_DEPOSITED",
  "P_CONFIRMED",
  "INVOICE_RECEIVED",
];

/**
 * The single transition table (ARCHITECTURE 7.1). Attempt number n of DELIVERED(n) is data, not state.
 *
 * EXPIRED rule: ESCROW_LOCKED / VERDICT_WITHHOLD -> EXPIRED happens ONLY when the wallet observes the
 * payment as Failed (HTLC timed out and failed back) or the invoice is cancelled. NEVER on a wall-clock
 * deadline: the HTLC, not our clock, decides when funds are free. A passed task deadline alone keeps
 * the state unchanged (DEADLINE_PASSED stops further deliveries). The engine must cite the wallet event.
 */
export const TASK_TRANSITIONS: Readonly<Record<TaskState, readonly TaskState[]>> = {
  DRAFT: ["MANDATE_SIGNED", "BLOCKED"],
  MANDATE_SIGNED: ["CHILD_DERIVED", "BLOCKED"],
  CHILD_DERIVED: ["OFFERED", "BLOCKED"],
  OFFERED: ["ACCEPTED", "BLOCKED"],
  ACCEPTED: ["P_DEPOSITED", "BLOCKED"],
  P_DEPOSITED: ["P_CONFIRMED", "BLOCKED"],
  P_CONFIRMED: ["INVOICE_RECEIVED", "BLOCKED"],
  INVOICE_RECEIVED: ["ESCROW_LOCKED", "BLOCKED"],
  ESCROW_LOCKED: ["DELIVERED", "APPROVED", "EXPIRED"],
  DELIVERED: ["VERDICT_RELEASE", "VERDICT_WITHHOLD", "APPROVED"],
  VERDICT_RELEASE: ["CLAIMED"],
  VERDICT_WITHHOLD: ["DELIVERED", "EXPIRED", "APPROVED"],
  APPROVED: ["CLAIMED"],
  EXPIRED: ["REFUNDED"],
  CLAIMED: [],
  REFUNDED: [],
  BLOCKED: [],
};

export const PRE_PAYMENT_STATES: readonly TaskState[] = PRE_PAYMENT;

export class TransitionError extends Error {
  override readonly name = "TransitionError";
  constructor(
    readonly from: TaskState,
    readonly to: TaskState,
  ) {
    super(`Illegal task transition ${from} -> ${to}`);
  }
}

export function canTransition(from: TaskState, to: TaskState): boolean {
  return TASK_TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertTransition(from: TaskState, to: TaskState): void {
  if (!canTransition(from, to)) throw new TransitionError(from, to);
}

/** Budget reservation states (7.2). */
export const RESERVATION_STATES = ["reserved", "committed", "released"] as const;
export type ReservationState = (typeof RESERVATION_STATES)[number];
export const RESERVATION_TRANSITIONS: Readonly<
  Record<ReservationState, readonly ReservationState[]>
> = {
  reserved: ["committed", "released"],
  committed: [],
  released: [],
};
export function assertReservationTransition(from: ReservationState, to: ReservationState): void {
  if (!RESERVATION_TRANSITIONS[from]?.includes(to))
    throw new Error(`Illegal reservation transition ${from} -> ${to}`);
}

export const PAYMENT_STATUSES = ["Pending", "Claimable", "Settled", "Failed"] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];
