// Types only (no runtime code): import from "@verdict/wallet/types".
// Field shape matches the capability-engine policy stand-in (authorizePaymentChecks.ts).

export interface DecodedInvoice {
  readonly payment_hash: string;
  /** minor units */
  readonly amount: bigint;
  readonly asset_id: string;
  readonly payee_node_id: string;
  readonly min_final_cltv_expiry_delta: number;
  /** Only bounds how long the invoice can be paid. NOT part of the lock-window check (ADR-021). */
  readonly expiry_sec: number;
}
