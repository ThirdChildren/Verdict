import type { PaymentStatus, TaskState } from "@verdict/protocol";

/** One short plain-language sentence per event or state, for a non-technical audience. */
export const TASK_CAPTIONS: Record<TaskState, string> = {
  DRAFT: "Nothing has started yet. The agent has no permission to spend.",
  MANDATE_SIGNED: "You signed the rules. The agent may only act inside them.",
  CHILD_DERIVED: "The agent got a smaller permission, just for this one task.",
  OFFERED: "The buyer agent sent a signed job offer to the worker.",
  ACCEPTED: "The worker accepted: both sides signed the same contract.",
  P_DEPOSITED: "A secret key was sealed and given to the verifier. Only the verifier can use it.",
  P_CONFIRMED: "The verifier confirmed it holds the key and the right test.",
  INVOICE_RECEIVED: "The worker's invoice matches the contract, so the budget is reserved.",
  ESCROW_LOCKED: "Funds are locked: the worker can only take them with the verifier's key.",
  DELIVERED: "The worker handed in its result. The verifier is testing it now.",
  VERDICT_RELEASE: "The test passed, so the verifier signed permission to pay.",
  VERDICT_WITHHOLD:
    "The test failed. The worker is cancelling the payment, so the money comes back to you.",
  APPROVED: "You approved by hand, skipping the verifier. The money is being released.",
  CLAIMED: "The worker collected the payment. The task is complete.",
  EXPIRED: "Time ran out. The locked funds are heading back to your budget.",
  REFUNDED: "The payment failed and the funds are back in your budget.",
  BLOCKED: "Your rules blocked this request. Nothing was signed and no funds moved.",
};

export const PAYMENT_CAPTIONS: Record<PaymentStatus, string> = {
  Pending: "Funds are locked in escrow. Nobody can take them yet.",
  Claimable: "The worker can see the locked funds and may claim them once it has the key.",
  Settled: "The payment went through and the worker was paid.",
  Failed: "The payment did not complete. The locked funds go back to your budget.",
};

export const VERDICT_CAPTIONS: Record<"RELEASE" | "WITHHOLD", string> = {
  RELEASE: "Every check passed, so the verifier allows the payment.",
  WITHHOLD: "At least one check failed, so the verifier keeps the money locked.",
};

export const HELD_CAPTION =
  "The test failed. The worker did not cancel, so the money stays locked until the escrow deadline. Then it comes back to you.";

export const STOPPED_CAPTION =
  "The worker vanished. The money stays locked until the escrow deadline, then comes back to you.";
