import { createHash } from "node:crypto";
import {
  type AssetBalance,
  assertHex32,
  assertRgbAmount,
  type CreateHodlInvoiceInput,
  type DecodedInvoice,
  LN_BLOCK_SECONDS,
  type PaymentStatus,
  type PaymentStatusEvent,
  WalletError,
  type WalletPort,
} from "./port.js";

interface Inv {
  decoded: DecodedInvoice;
  status: PaymentStatus;
}

/** Shared in-memory "network": FakeWallets with the same hub can pay each other's invoices. Tests only. */
export class FakeHub {
  invoices = new Map<string, Inv & { owner: FakeWallet }>();
  payers = new Map<string, FakeWallet>();
}

/** In-memory WalletPort implementing the same HODL semantics. Throws when VERDICT_MODE=demo. */
export class FakeWallet implements WalletPort {
  private listeners = new Set<(e: PaymentStatusEvent) => void>();
  private balances = new Map<string, bigint>();
  private seq = 0;
  readonly claimed: string[] = [];

  constructor(
    readonly node: string = `02${"ab".repeat(32)}`,
    private readonly hub: FakeHub = new FakeHub(),
  ) {
    if (process.env.VERDICT_MODE === "demo")
      throw new WalletError(
        "WALLET_FAKE_IN_DEMO",
        "FakeWallet is not allowed when VERDICT_MODE=demo",
      );
  }

  setBalance(assetId: string, units: bigint): void {
    this.balances.set(assetId, units);
  }
  private seen = new Map<string, PaymentStatusEvent>();
  async paymentStatus(paymentHash: string): Promise<PaymentStatusEvent[]> {
    const r = [...this.seen.values()].filter((e) => e.paymentHash === paymentHash);
    if (r.length === 0)
      throw new WalletError(
        "WALLET_INVALID_INPUT",
        "This wallet has seen no payment or invoice with that hash",
      );
    return r;
  }
  private emit(e: PaymentStatusEvent): void {
    this.seen.set(`${e.role}:${e.paymentHash}`, e);
    for (const l of this.listeners) l(e);
  }
  async init(): Promise<void> {}
  async close(): Promise<void> {
    this.listeners.clear();
  }
  async nodeId(): Promise<string> {
    return this.node;
  }
  async signMessage(msg: string): Promise<string> {
    return `fakesig:${this.node}:${createHash("sha256").update(msg).digest("hex")}`;
  }
  async assetBalance(assetId: string): Promise<AssetBalance> {
    const v = this.balances.get(assetId) ?? 0n;
    return { settled: v, future: v, spendable: v, offchainOutbound: v, offchainInbound: 0n };
  }
  async createHodlInvoice(i: CreateHodlInvoiceInput) {
    assertHex32(i.paymentHash, "paymentHash");
    const bolt11 = `lnbcrtfake${++this.seq}x${i.paymentHash}`;
    const delta = (i.minFinalCltvExpiryDelta ?? 39) + 3;
    const decoded: DecodedInvoice = {
      paymentHash: i.paymentHash,
      assetId: i.assetId,
      assetAmount: i.assetAmount,
      amtMsat: i.amtMsat,
      payeeNodeId: this.node,
      expiresAt: new Date(Date.now() + i.expirySec * 1000).toISOString(),
      minFinalCltvExpiryDelta: delta,
      lockSeconds: delta * LN_BLOCK_SECONDS,
    };
    this.hub.invoices.set(bolt11, { decoded, status: "Pending", owner: this });
    return { bolt11, paymentHash: i.paymentHash };
  }
  async decodeInvoice(bolt11: string): Promise<DecodedInvoice> {
    const inv = this.hub.invoices.get(bolt11);
    if (!inv) throw new WalletError("WALLET_INVALID_INPUT", "unknown invoice");
    return inv.decoded;
  }
  async pay(bolt11: string) {
    const inv = this.hub.invoices.get(bolt11);
    if (!inv) throw new WalletError("WALLET_INVALID_INPUT", "unknown invoice");
    assertRgbAmount(inv.decoded.amtMsat);
    const h = inv.decoded.paymentHash;
    this.hub.payers.set(h, this);
    inv.status = "Claimable";
    inv.owner.emit({ paymentHash: h, status: "Claimable", role: "payee" });
    this.emit({ paymentHash: h, status: "Pending", role: "payer" });
    return { paymentHash: h, status: "Pending" as PaymentStatus };
  }
  async claimHodlInvoice(paymentHash: string, preimageHex: string) {
    assertHex32(paymentHash, "paymentHash");
    assertHex32(preimageHex, "preimage");
    if (createHash("sha256").update(Buffer.from(preimageHex, "hex")).digest("hex") !== paymentHash)
      throw new WalletError("WALLET_INVALID_INPUT", "preimage does not match payment hash");
    const inv = [...this.hub.invoices.values()].find((x) => x.decoded.paymentHash === paymentHash);
    if (!inv || inv.status !== "Claimable") return { changed: false };
    inv.status = "Settled";
    this.claimed.push(paymentHash);
    const a = inv.decoded.assetId;
    if (a && inv.decoded.assetAmount !== null) {
      this.balances.set(a, (this.balances.get(a) ?? 0n) + inv.decoded.assetAmount);
      const payer = this.hub.payers.get(paymentHash);
      payer?.balances.set(a, (payer.balances.get(a) ?? 0n) - inv.decoded.assetAmount);
    }
    this.emit({ paymentHash, status: "Settled", role: "payee" });
    this.hub.payers.get(paymentHash)?.emit({ paymentHash, status: "Settled", role: "payer" });
    return { changed: true };
  }
  async cancelHodlInvoice(paymentHash: string): Promise<void> {
    const inv = [...this.hub.invoices.values()].find((x) => x.decoded.paymentHash === paymentHash);
    if (!inv) throw new WalletError("WALLET_INVALID_INPUT", "unknown invoice");
    if (inv.status === "Settled") throw new WalletError("WALLET_NODE_ERROR", "already settled");
    inv.status = "Failed";
    this.emit({ paymentHash, status: "Failed", role: "payee" });
    this.hub.payers
      .get(paymentHash)
      ?.emit({ paymentHash, status: "Failed", role: "payer", failureCode: "RECIPIENT_REJECTED" });
  }
  /** Test helper: simulate the lock window running out (payer sees Failed, funds stay with payer). */
  expireLock(paymentHash: string): void {
    const inv = [...this.hub.invoices.values()].find((x) => x.decoded.paymentHash === paymentHash);
    if (inv && inv.status === "Claimable") {
      this.hub.payers
        .get(paymentHash)
        ?.emit({ paymentHash, status: "Failed", role: "payer", failureCode: "RECIPIENT_REJECTED" });
    }
  }
  onPaymentStatus(cb: (e: PaymentStatusEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  async issueTusd(amount: bigint, _precision: number) {
    const assetId = "rgb:fake-tusd";
    this.balances.set(assetId, (this.balances.get(assetId) ?? 0n) + amount);
    return { assetId };
  }
  async openRgbChannel(_i: {
    peer: string;
    assetId: string;
    assetAmount: bigint;
    capacitySat: number;
  }) {
    return { temporaryChannelId: "fake-channel" };
  }
}
