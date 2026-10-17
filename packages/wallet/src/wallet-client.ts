import {
  type AssetBalance,
  type CreateHodlInvoiceInput,
  type DecodedInvoice,
  type PaymentStatus,
  type PaymentStatusEvent,
  WalletError,
  type WalletPort,
} from "./port.js";

/** Wire format of the wallet daemon (apps/wallet-daemon): every bigint travels as a decimal string. */
export const WALLET_API = "/v0";

export interface WalletClientOptions {
  /** e.g. http://127.0.0.1:7411 */
  baseUrl: string;
  /** Per-call timeout (ms). A timeout is a failure (fail closed). */
  timeoutMs?: number;
  /** `pay` can take longer than a lookup. */
  payTimeoutMs?: number;
  /** Delay before the event socket reconnects (ms). */
  reconnectMs?: number;
}

function rec(o: unknown, what: string): Record<string, unknown> {
  if (typeof o !== "object" || o === null)
    throw new WalletError("WALLET_NODE_ERROR", `${what}: not an object`);
  return o as Record<string, unknown>;
}
function str(o: Record<string, unknown>, k: string, what: string): string {
  const v = o[k];
  if (typeof v !== "string") throw new WalletError("WALLET_NODE_ERROR", `${what}: missing "${k}"`);
  return v;
}
function bigOf(o: Record<string, unknown>, k: string, what: string): bigint {
  const v = o[k];
  if (typeof v === "string" && /^\d+$/.test(v)) return BigInt(v);
  throw new WalletError("WALLET_NODE_ERROR", `${what}: "${k}" is not a decimal string`);
}
const STATUSES: readonly string[] = ["Pending", "Claimable", "Settled", "Failed"];
function statusOf(o: Record<string, unknown>, what: string): PaymentStatus {
  const s = str(o, "status", what);
  if (!STATUSES.includes(s))
    throw new WalletError("WALLET_NODE_ERROR", `${what}: unknown status "${s}"`);
  return s as PaymentStatus;
}

export function parsePaymentEvent(raw: unknown): PaymentStatusEvent {
  const o = rec(raw, "event");
  const role = str(o, "role", "event");
  if (role !== "payer" && role !== "payee")
    throw new WalletError("WALLET_NODE_ERROR", "event: bad role");
  return {
    paymentHash: str(o, "paymentHash", "event"),
    status: statusOf(o, "event"),
    role,
    ...(typeof o.failureCode === "string" ? { failureCode: o.failureCode } : {}),
  };
}

/**
 * WalletPort over the local wallet daemon's HTTP API. Holds no keys and no node: the daemon owns both.
 * Events come from the daemon's WebSocket (/v0/events), which reconnects until close().
 */
export class WalletClient implements WalletPort {
  private readonly base: string;
  private readonly timeoutMs: number;
  private readonly payTimeoutMs: number;
  private readonly reconnectMs: number;
  private listeners = new Set<(e: PaymentStatusEvent) => void>();
  private socket: WebSocket | undefined;
  private closed = false;
  private retry: ReturnType<typeof setTimeout> | undefined;

  constructor(opts: WalletClientOptions) {
    this.base = opts.baseUrl.replace(/\/+$/, "");
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.payTimeoutMs = opts.payTimeoutMs ?? 45_000;
    this.reconnectMs = opts.reconnectMs ?? 1_000;
  }

  private async req(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    timeoutMs = this.timeoutMs,
  ): Promise<Record<string, unknown>> {
    const label = `${method} ${path}`;
    let res: Response;
    try {
      res = await fetch(`${this.base}${WALLET_API}${path}`, {
        method,
        headers: body === undefined ? {} : { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
      throw new WalletError(
        timedOut ? "WALLET_TIMEOUT" : "WALLET_NODE_ERROR",
        timedOut
          ? `Wallet daemon did not answer ${label} within ${timeoutMs} ms`
          : `Wallet daemon unreachable at ${this.base} (${label}): ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new WalletError("WALLET_NODE_ERROR", `${label}: daemon sent a non-JSON answer`);
    }
    if (!res.ok) {
      const o = typeof json === "object" && json !== null ? (json as Record<string, unknown>) : {};
      const code = typeof o.code === "string" ? o.code : "WALLET_NODE_ERROR";
      const known = [
        "WALLET_INVALID_INPUT",
        "WALLET_AMOUNT_TOO_SMALL",
        "WALLET_TIMEOUT",
        "WALLET_NODE_ERROR",
        "WALLET_UNSUPPORTED",
        "WALLET_FAKE_IN_DEMO",
      ] as const;
      throw new WalletError(
        known.find((k) => k === code) ?? "WALLET_NODE_ERROR",
        typeof o.message === "string" ? o.message : `${label} failed with HTTP ${res.status}`,
      );
    }
    return rec(json, label);
  }

  async init(): Promise<void> {
    await this.req("GET", "/health");
  }
  async close(): Promise<void> {
    this.closed = true;
    clearTimeout(this.retry);
    this.listeners.clear();
    this.socket?.close();
    this.socket = undefined;
  }
  async nodeId(): Promise<string> {
    return str(await this.req("GET", "/node"), "nodeId", "node");
  }
  async signMessage(msg: string): Promise<string> {
    return str(await this.req("POST", "/sign", { message: msg }), "signature", "sign");
  }
  async assetBalance(assetId: string): Promise<AssetBalance> {
    const b = await this.req("GET", `/balance/${encodeURIComponent(assetId)}`);
    return {
      settled: bigOf(b, "settled", "balance"),
      future: bigOf(b, "future", "balance"),
      spendable: bigOf(b, "spendable", "balance"),
      offchainOutbound: bigOf(b, "offchainOutbound", "balance"),
      offchainInbound: bigOf(b, "offchainInbound", "balance"),
    };
  }
  async createHodlInvoice(i: CreateHodlInvoiceInput) {
    const r = await this.req("POST", "/invoices/hodl", {
      paymentHash: i.paymentHash,
      assetId: i.assetId,
      assetAmount: i.assetAmount.toString(),
      amtMsat: i.amtMsat.toString(),
      expirySec: i.expirySec,
      ...(i.minFinalCltvExpiryDelta !== undefined
        ? { minFinalCltvExpiryDelta: i.minFinalCltvExpiryDelta }
        : {}),
    });
    return { bolt11: str(r, "bolt11", "invoice"), paymentHash: str(r, "paymentHash", "invoice") };
  }
  async decodeInvoice(bolt11: string): Promise<DecodedInvoice> {
    const d = await this.req("POST", "/invoices/decode", { bolt11 });
    const delta = d.minFinalCltvExpiryDelta;
    const lock = d.lockSeconds;
    if (typeof delta !== "number" || typeof lock !== "number")
      throw new WalletError("WALLET_NODE_ERROR", "decode: missing CLTV fields");
    return {
      paymentHash: str(d, "paymentHash", "decode"),
      assetId: typeof d.assetId === "string" ? d.assetId : null,
      assetAmount: typeof d.assetAmount === "string" ? bigOf(d, "assetAmount", "decode") : null,
      amtMsat: bigOf(d, "amtMsat", "decode"),
      payeeNodeId: str(d, "payeeNodeId", "decode"),
      expiresAt: str(d, "expiresAt", "decode"),
      minFinalCltvExpiryDelta: delta,
      lockSeconds: lock,
    };
  }
  async pay(bolt11: string) {
    const r = await this.req("POST", "/payments", { bolt11 }, this.payTimeoutMs);
    return {
      paymentHash: str(r, "paymentHash", "pay"),
      status: statusOf(r, "pay"),
      ...(typeof r.failureCode === "string" ? { failureCode: r.failureCode } : {}),
    };
  }
  async claimHodlInvoice(paymentHash: string, preimageHex: string) {
    const r = await this.req("POST", "/invoices/claim", { paymentHash, preimage: preimageHex });
    return { changed: r.changed === true };
  }
  async cancelHodlInvoice(paymentHash: string): Promise<void> {
    await this.req("POST", "/invoices/cancel", { paymentHash });
  }
  /** Last status the daemon saw for this hash (one entry per role it plays), newest data the daemon has. */
  async paymentStatus(paymentHash: string): Promise<PaymentStatusEvent[]> {
    const r = await this.req("GET", `/payments/${encodeURIComponent(paymentHash)}`);
    if (!Array.isArray(r.statuses))
      throw new WalletError("WALLET_NODE_ERROR", "paymentStatus: missing statuses");
    return r.statuses.map(parsePaymentEvent);
  }

  onPaymentStatus(cb: (e: PaymentStatusEvent) => void): () => void {
    this.listeners.add(cb);
    this.connect();
    return () => {
      this.listeners.delete(cb);
    };
  }
  private connect(): void {
    if (this.socket || this.closed) return;
    const ws = new WebSocket(`${this.base.replace(/^http/, "ws")}${WALLET_API}/events`);
    this.socket = ws;
    ws.onmessage = (m) => {
      let ev: PaymentStatusEvent;
      try {
        ev = parsePaymentEvent(JSON.parse(String(m.data)));
      } catch {
        return; // malformed frame: ignore, never invent an event
      }
      for (const l of this.listeners) l(ev);
    };
    const again = () => {
      if (this.socket === ws) this.socket = undefined;
      if (this.closed || this.listeners.size === 0) return;
      this.retry = setTimeout(() => this.connect(), this.reconnectMs);
      this.retry.unref?.();
    };
    ws.onclose = again;
    ws.onerror = () => ws.close();
  }

  issueTusd(): Promise<{ assetId: string }> {
    throw new WalletError("WALLET_UNSUPPORTED", "Issue tUSD with `pnpm regtest:setup`");
  }
  /** Setup only: the buyer daemon opens the channel itself so it lives in the same process as the signer. */
  async openRgbChannel(i: {
    peer: string;
    assetId: string;
    assetAmount: bigint;
    capacitySat: number;
  }) {
    const r = await this.req(
      "POST",
      "/admin/open-channel",
      {
        peer: i.peer,
        assetId: i.assetId,
        assetAmount: i.assetAmount.toString(),
        capacitySat: i.capacitySat,
      },
      120_000,
    );
    return { temporaryChannelId: str(r, "temporaryChannelId", "openChannel") };
  }
}
