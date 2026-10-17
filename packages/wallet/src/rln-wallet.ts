import type { WalletAccountRgbLightning } from "@utexo/wdk-rgb-lightning";
import {
  type AssetBalance,
  assertHex32,
  assertRgbAmount,
  type CreateHodlInvoiceInput,
  DEFAULT_POLL_INTERVAL_MS,
  type DecodedInvoice,
  LN_BLOCK_SECONDS,
  type PaymentStatus,
  type PaymentStatusEvent,
  WalletError,
  type WalletPort,
} from "./port.js";

/**
 * The subset of the real `WalletAccountRgbLightning` (`@utexo/wdk-rgb-lightning` 0.1.0-beta.15) used here.
 * Type-only import: the native binding is never loaded by importing this file. Most results are typed `object`
 * upstream (forwarded RLN JSON), so they are still validated field by field below.
 */
export type RlnAccountLike = Pick<
  WalletAccountRgbLightning,
  | "getNodeInfo"
  | "createHodlInvoice"
  | "decodeInvoice"
  | "getInvoiceStatus"
  | "getPayment"
  | "sendPayment"
  | "claimHodlInvoice"
  | "cancelHodlInvoice"
  | "getAssetBalance"
  | "sign"
  | "connectPeer"
  | "openChannel"
>;

export interface RlnWalletOptions {
  /** Every account call is raced against this; a timeout is a failure (fail closed). Proposed 30 s, not measured. */
  callTimeoutMs?: number;
  pollIntervalMs?: number;
  /** Called by close(), e.g. manager.dispose(). */
  onClose?: () => void | Promise<void>;
}

function rec(o: unknown, what: string): Record<string, unknown> {
  if (typeof o !== "object" || o === null)
    throw new WalletError("WALLET_NODE_ERROR", `${what}: not an object`);
  return o as Record<string, unknown>;
}
function str(o: Record<string, unknown>, k: string, what: string): string {
  const v = o[k];
  if (typeof v !== "string")
    throw new WalletError("WALLET_NODE_ERROR", `${what}: missing string "${k}"`);
  return v;
}
function num(o: Record<string, unknown>, k: string, what: string): number {
  const v = o[k];
  if (typeof v !== "number" || !Number.isFinite(v))
    throw new WalletError("WALLET_NODE_ERROR", `${what}: missing number "${k}"`);
  return v;
}
function big(o: Record<string, unknown>, k: string, what: string): bigint {
  const v = o[k];
  if (typeof v === "bigint") return v;
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  throw new WalletError("WALLET_NODE_ERROR", `${what}: missing integer "${k}"`);
}

/** Maps RLN strings (verified P0.3) to the port vocabulary. Unknown strings fail closed. */
export function mapStatus(s: string): PaymentStatus {
  switch (s) {
    case "Pending":
      return "Pending";
    case "Claimable":
    case "Claiming": // claim in progress: funds are no longer at risk of timing out but not settled yet
      return "Claimable";
    case "Succeeded":
      return "Settled";
    default: // Cancelled | Failed | Expired | anything unknown
      return "Failed";
  }
}

interface Watch {
  role: "payer" | "payee";
  bolt11?: string;
  last?: PaymentStatus;
}

/**
 * WalletPort over a WDK RGB-Lightning account.
 * Status events come from polling (default every 500 ms): invoices via getInvoiceStatus, payments via getPayment(hash, "Outbound").
 * No node-based verify: control-plane signatures use the EIP-191 / Ed25519 signers and the pure verifiers.
 */
export class RlnWallet implements WalletPort {
  private watches = new Map<string, Watch>();
  private listeners = new Set<(e: PaymentStatusEvent) => void>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private polling = false;
  private readonly lastPollError = new Map<string, string>();
  private readonly timeoutMs: number;
  private readonly pollMs: number;
  private pubkey: string | undefined;

  constructor(
    private readonly acc: RlnAccountLike,
    private readonly opts: RlnWalletOptions = {},
  ) {
    this.timeoutMs = opts.callTimeoutMs ?? 30_000;
    this.pollMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  }

  private async call<T>(label: string, p: () => Promise<T>): Promise<T> {
    let t: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        p(),
        new Promise<never>((_, rej) => {
          t = setTimeout(
            () =>
              rej(
                new WalletError(
                  "WALLET_TIMEOUT",
                  `${label} did not answer within ${this.timeoutMs} ms`,
                ),
              ),
            this.timeoutMs,
          );
        }),
      ]);
    } catch (e) {
      if (e instanceof WalletError) throw e;
      throw new WalletError(
        "WALLET_NODE_ERROR",
        `${label} failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      clearTimeout(t);
    }
  }

  async init(): Promise<void> {
    await this.nodeId();
  }
  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.listeners.clear();
    await this.opts.onClose?.();
  }
  async nodeId(): Promise<string> {
    if (!this.pubkey) {
      const info = rec(await this.call("getNodeInfo", () => this.acc.getNodeInfo()), "nodeInfo");
      this.pubkey = str(info, "pubkey", "nodeInfo");
    }
    return this.pubkey;
  }
  signMessage(msg: string): Promise<string> {
    return this.call("sign", () => this.acc.sign(msg));
  }
  async assetBalance(assetId: string): Promise<AssetBalance> {
    const b = rec(
      await this.call("getAssetBalance", () => this.acc.getAssetBalance(assetId)),
      "assetBalance",
    );
    return {
      settled: big(b, "settled", "assetBalance"),
      future: big(b, "future", "assetBalance"),
      spendable: big(b, "spendable", "assetBalance"),
      offchainOutbound: big(b, "offchain_outbound", "assetBalance"),
      offchainInbound: big(b, "offchain_inbound", "assetBalance"),
    };
  }

  async createHodlInvoice(i: CreateHodlInvoiceInput) {
    assertHex32(i.paymentHash, "paymentHash");
    assertRgbAmount(i.amtMsat);
    if (i.assetAmount <= 0n)
      throw new WalletError("WALLET_INVALID_INPUT", "assetAmount must be positive");
    if (!Number.isSafeInteger(i.expirySec) || i.expirySec <= 0)
      throw new WalletError("WALLET_INVALID_INPUT", "expirySec must be a positive integer");
    const r = await this.call("createHodlInvoice", () =>
      this.acc.createHodlInvoice({
        paymentHash: i.paymentHash,
        assetId: i.assetId,
        assetAmount: Number(i.assetAmount),
        amtMsat: Number(i.amtMsat),
        expirySec: i.expirySec,
        ...(i.minFinalCltvExpiryDelta !== undefined
          ? { minFinalCltvExpiryDelta: i.minFinalCltvExpiryDelta }
          : {}),
      }),
    );
    if (typeof r.bolt11 !== "string" || r.paymentHash !== i.paymentHash)
      throw new WalletError(
        "WALLET_NODE_ERROR",
        "createHodlInvoice returned an unexpected invoice",
      );
    this.watch(i.paymentHash, { role: "payee", bolt11: r.bolt11 });
    return { bolt11: r.bolt11, paymentHash: r.paymentHash };
  }

  async decodeInvoice(bolt11: string): Promise<DecodedInvoice> {
    const d = rec(
      await this.call("decodeInvoice", () => this.acc.decodeInvoice(bolt11)),
      "decodeInvoice",
    );
    const delta = num(d, "min_final_cltv_expiry_delta", "decodeInvoice");
    const assetId = d.asset_id;
    const assetAmount = d.asset_amount;
    return {
      paymentHash: str(d, "payment_hash", "decodeInvoice"),
      assetId: typeof assetId === "string" ? assetId : null,
      assetAmount:
        assetAmount === null || assetAmount === undefined
          ? null
          : big(d, "asset_amount", "decodeInvoice"),
      amtMsat: big(d, "amt_msat", "decodeInvoice"),
      payeeNodeId: str(d, "payee_pubkey", "decodeInvoice"),
      // `timestamp` is in seconds (P0.3 logs: 1791587083)
      expiresAt: new Date(
        (num(d, "timestamp", "decodeInvoice") + num(d, "expiry_sec", "decodeInvoice")) * 1000,
      ).toISOString(),
      minFinalCltvExpiryDelta: delta,
      lockSeconds: delta * LN_BLOCK_SECONDS,
    };
  }

  async pay(bolt11: string) {
    const dec = await this.decodeInvoice(bolt11);
    if (dec.assetId !== null) assertRgbAmount(dec.amtMsat); // the node throws too; fail before the call
    const r = rec(
      await this.call("sendPayment", () => this.acc.sendPayment({ invoice: bolt11 })),
      "sendPayment",
    );
    const status = mapStatus(str(r, "status", "sendPayment"));
    const failureCode = typeof r.failure_code === "string" ? r.failure_code : undefined;
    if (status === "Pending") this.watch(dec.paymentHash, { role: "payer", last: status });
    // Already terminal (e.g. ROUTE_NOT_FOUND): no later poll would report it, so emit it now.
    else
      for (const l of this.listeners)
        l({
          paymentHash: dec.paymentHash,
          status,
          role: "payer",
          ...(failureCode ? { failureCode } : {}),
        });
    return { paymentHash: dec.paymentHash, status, ...(failureCode ? { failureCode } : {}) };
  }

  async claimHodlInvoice(paymentHash: string, preimageHex: string) {
    assertHex32(paymentHash, "paymentHash");
    assertHex32(preimageHex, "preimage");
    const r = rec(
      await this.call("claimHodlInvoice", () =>
        this.acc.claimHodlInvoice({ payment_hash: paymentHash, payment_preimage: preimageHex }),
      ),
      "claimHodlInvoice",
    );
    return { changed: r.changed === true };
  }
  async cancelHodlInvoice(paymentHash: string): Promise<void> {
    assertHex32(paymentHash, "paymentHash");
    await this.call("cancelHodlInvoice", () =>
      this.acc.cancelHodlInvoice({ payment_hash: paymentHash }),
    );
  }

  async paymentStatus(paymentHash: string): Promise<PaymentStatusEvent[]> {
    assertHex32(paymentHash, "paymentHash");
    const seen: PaymentStatusEvent[] = [];
    for (const [key, w] of this.watches)
      if (key.endsWith(`:${paymentHash}`) && w.last)
        seen.push({ paymentHash, status: w.last, role: w.role });
    if (seen.length === 0) {
      // After a restart the in-memory watches are gone, but the node still knows its payments:
      // ask it, so a second pay() for the same hash is refused instead of sent again.
      const known = await this.outboundFromNode(paymentHash);
      if (known) return [known];
    }
    if (seen.length === 0)
      throw new WalletError(
        "WALLET_INVALID_INPUT",
        "This wallet has seen no payment or invoice with that hash",
      );
    return seen;
  }

  /** The node's own outbound record for this hash (re-armed as a watch while Pending), undefined if it has none. */
  private async outboundFromNode(paymentHash: string): Promise<PaymentStatusEvent | undefined> {
    let p: Record<string, unknown>;
    try {
      p = rec(
        await this.call("getPayment", () => this.acc.getPayment(paymentHash, "Outbound")),
        "payment",
      );
    } catch (e) {
      // The node reports a missing payment as NotFound. Any other failure must not read as "never paid".
      if (e instanceof WalletError && /not\s*found/i.test(e.message)) return undefined;
      throw e;
    }
    const status = mapStatus(str(p, "status", "payment"));
    if (status === "Pending") this.watch(paymentHash, { role: "payer", last: status });
    return { paymentHash, status, role: "payer" };
  }

  onPaymentStatus(cb: (e: PaymentStatusEvent) => void): () => void {
    this.listeners.add(cb);
    this.ensurePolling();
    return () => {
      this.listeners.delete(cb);
    };
  }
  private watch(hash: string, w: Watch): void {
    this.watches.set(`${w.role}:${hash}`, w);
    if (this.listeners.size > 0) this.ensurePolling();
  }
  private ensurePolling(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.pollOnce(), this.pollMs);
    this.timer.unref?.();
  }

  /** One poll pass (public so tests and scripts can drive it without timers). Errors skip the entry; the next pass retries. */
  async pollOnce(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      for (const [key, w] of this.watches) {
        const hash = key.slice(key.indexOf(":") + 1);
        let status: PaymentStatus;
        let failureCode: string | undefined;
        try {
          if (w.role === "payee" && w.bolt11) {
            status = mapStatus(
              str(
                rec(
                  await this.call("getInvoiceStatus", () =>
                    this.acc.getInvoiceStatus(w.bolt11 as string),
                  ),
                  "invoiceStatus",
                ),
                "status",
                "invoiceStatus",
              ),
            );
          } else {
            const p = rec(
              await this.call("getPayment", () => this.acc.getPayment(hash, "Outbound")),
              "payment",
            );
            status = mapStatus(str(p, "status", "payment"));
            if (typeof p.failure_code === "string") failureCode = p.failure_code;
          }
        } catch (e) {
          // Never silent: a poll that keeps failing is why a payment can look stuck. Logged once per distinct error.
          const msg = e instanceof Error ? e.message : String(e);
          if (this.lastPollError.get(key) !== msg) {
            this.lastPollError.set(key, msg);
            console.warn(
              `[rln-wallet] status poll failed for ${w.role} ${hash.slice(0, 12)}: ${msg}`,
            );
          }
          continue;
        }
        if (status === w.last) continue;
        w.last = status;
        const ev: PaymentStatusEvent = {
          paymentHash: hash,
          status,
          role: w.role,
          ...(failureCode ? { failureCode } : {}),
        };
        for (const l of this.listeners) l(ev);
        if (status === "Settled" || (status === "Failed" && w.role === "payer"))
          this.watches.delete(key);
      }
    } finally {
      this.polling = false;
    }
  }

  issueTusd(): Promise<{ assetId: string }> {
    throw new WalletError(
      "WALLET_UNSUPPORTED",
      "The RGB-LN account cannot issue assets (external signer mode); use infra/regtest/issuer via `pnpm regtest:setup`",
    );
  }
  /** `pubkey@host:port`. Peers are not reconnected after a node restart (verified on regtest), so call this after unlock. */
  async connectPeer(peer: string): Promise<void> {
    await this.call("connectPeer", () => this.acc.connectPeer(peer));
  }
  async openRgbChannel(i: {
    peer: string;
    assetId: string;
    assetAmount: bigint;
    capacitySat: number;
  }) {
    await this.call("connectPeer", () => this.acc.connectPeer(i.peer));
    const r = rec(
      await this.call("openChannel", () =>
        this.acc.openChannel({
          peer_pubkey_and_opt_addr: i.peer,
          capacity_sat: i.capacitySat,
          push_msat: 0,
          asset_id: i.assetId,
          asset_amount: Number(i.assetAmount),
          public: false,
          with_anchors: true,
        }),
      ),
      "openChannel",
    );
    return { temporaryChannelId: str(r, "temporary_channel_id", "openChannel") };
  }
}
