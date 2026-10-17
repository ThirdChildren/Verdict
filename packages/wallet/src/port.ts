/** WalletPort: the only surface the rest of Verdict uses to touch RGB-over-Lightning. Money is bigint minor units. */

/** One Bitcoin block is budgeted as 600 s when turning `min_final_cltv_expiry_delta` into a lock window. */
export const LN_BLOCK_SECONDS = 600;
/** Verified on regtest (P0.3): a payer refuses RGB HTLCs below this. */
export const RGB_MIN_HTLC_MSAT = 3_000_000n;
/** Default status poll interval of `onPaymentStatus` (ms). */
export const DEFAULT_POLL_INTERVAL_MS = 500;

export type PaymentStatus = "Pending" | "Claimable" | "Settled" | "Failed";

export interface PaymentStatusEvent {
  paymentHash: string;
  status: PaymentStatus;
  /** payer = we sent the HTLC; payee = we issued the HODL invoice. */
  role: "payer" | "payee";
  /** e.g. RECIPIENT_REJECTED, ROUTE_NOT_FOUND (payer side only). */
  failureCode?: string;
}

export interface CreateHodlInvoiceInput {
  paymentHash: string;
  assetId: string;
  assetAmount: bigint;
  amtMsat: bigint;
  expirySec: number;
  /** Requested CLTV delta in blocks; values below 39 are rejected by the node. Omit for the minimum. */
  minFinalCltvExpiryDelta?: number;
}

export interface DecodedInvoice {
  paymentHash: string;
  assetId: string | null;
  assetAmount: bigint | null;
  amtMsat: bigint;
  payeeNodeId: string;
  /** ISO UTC; bounds when the invoice may START to be paid. It is NOT the lock window. */
  expiresAt: string;
  minFinalCltvExpiryDelta: number;
  /** minFinalCltvExpiryDelta x 600 s: the HTLC lock window the engine checks (invariant 4). */
  lockSeconds: number;
}

export interface AssetBalance {
  settled: bigint;
  future: bigint;
  spendable: bigint;
  offchainOutbound: bigint;
  offchainInbound: bigint;
}

export interface WalletPort {
  init(): Promise<void>;
  close(): Promise<void>;
  /** Lightning node pubkey (33-byte compressed hex). */
  nodeId(): Promise<string>;
  /** Lightning-node message signature. Not used for control-plane signing; there is deliberately no node-based verify. */
  signMessage(msg: string): Promise<string>;
  assetBalance(assetId: string): Promise<AssetBalance>;
  createHodlInvoice(
    input: CreateHodlInvoiceInput,
  ): Promise<{ bolt11: string; paymentHash: string }>;
  decodeInvoice(bolt11: string): Promise<DecodedInvoice>;
  pay(
    bolt11: string,
  ): Promise<{ paymentHash: string; status: PaymentStatus; failureCode?: string }>;
  claimHodlInvoice(paymentHash: string, preimageHex: string): Promise<{ changed: boolean }>;
  cancelHodlInvoice(paymentHash: string): Promise<void>;
  /** Last status seen per role for this hash. Rejects with WALLET_INVALID_INPUT when the wallet never saw it. */
  paymentStatus(paymentHash: string): Promise<PaymentStatusEvent[]>;
  /** Emits on every status change of invoices we created and payments we sent. Returns an unsubscribe fn. */
  onPaymentStatus(cb: (e: PaymentStatusEvent) => void): () => void;
  /** Setup only (regtest scripts). */
  issueTusd(amount: bigint, precision: number): Promise<{ assetId: string }>;
  openRgbChannel(input: {
    peer: string;
    assetId: string;
    assetAmount: bigint;
    capacitySat: number;
  }): Promise<{ temporaryChannelId: string }>;
}

export class WalletError extends Error {
  constructor(
    readonly code:
      | "WALLET_INVALID_INPUT"
      | "WALLET_AMOUNT_TOO_SMALL"
      | "WALLET_TIMEOUT"
      | "WALLET_NODE_ERROR"
      | "WALLET_UNSUPPORTED"
      | "WALLET_FAKE_IN_DEMO",
    message: string,
  ) {
    super(message);
    this.name = "WalletError";
  }
}

const HEX32 = /^[0-9a-f]{64}$/;
export function assertHex32(v: string, what: string): void {
  if (!HEX32.test(v))
    throw new WalletError("WALLET_INVALID_INPUT", `${what} must be 64 lowercase hex chars`);
}
export function assertRgbAmount(amtMsat: bigint): void {
  if (amtMsat < RGB_MIN_HTLC_MSAT)
    throw new WalletError(
      "WALLET_AMOUNT_TOO_SMALL",
      `An RGB payment needs at least ${RGB_MIN_HTLC_MSAT} msat attached; got ${amtMsat}`,
    );
}
