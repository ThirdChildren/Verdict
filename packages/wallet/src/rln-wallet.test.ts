import { describe, expect, it, vi } from "vitest";
import { mapStatus, type PaymentStatusEvent, type RlnAccountLike, RlnWallet } from "./index.js";

const HASH = "d1".repeat(32);
const DEC = {
  amt_msat: 3000000,
  expiry_sec: 3600,
  timestamp: 1791587083,
  asset_id: "rgb:abc",
  asset_amount: 1000,
  payment_hash: HASH,
  payee_pubkey: `02${"cd".repeat(32)}`,
  min_final_cltv_expiry_delta: 42,
};

function acct(over: Partial<Record<keyof RlnAccountLike, unknown>> = {}): RlnAccountLike {
  const base = {
    getNodeInfo: async () => ({ pubkey: `02${"ab".repeat(32)}` }),
    createHodlInvoice: async (r: { paymentHash: string }) => ({
      bolt11: "lnbcrt1x",
      paymentHash: r.paymentHash,
    }),
    decodeInvoice: async () => DEC,
    getInvoiceStatus: async () => ({ status: "Pending" }),
    getPayment: async () => ({ status: "Pending" }),
    sendPayment: async () => ({ status: "Pending", payment_hash: HASH }),
    claimHodlInvoice: async () => ({ changed: true }),
    cancelHodlInvoice: async () => ({ ok: true }),
    getAssetBalance: async () => ({
      settled: 5,
      future: 5,
      spendable: 5,
      offchain_outbound: 1,
      offchain_inbound: 2,
    }),
    sign: async () => "sig",
    verify: async () => true,
    connectPeer: async () => ({}),
    openChannel: async () => ({ temporary_channel_id: "tmp" }),
  };
  return { ...base, ...over } as unknown as RlnAccountLike;
}

describe("RlnWallet adapter (mock account, no node)", () => {
  it("maps statuses and fails closed on unknown strings", () => {
    expect(
      [
        "Pending",
        "Claimable",
        "Claiming",
        "Succeeded",
        "Cancelled",
        "Failed",
        "Expired",
        "???",
      ].map(mapStatus),
    ).toEqual([
      "Pending",
      "Claimable",
      "Claimable",
      "Settled",
      "Failed",
      "Failed",
      "Failed",
      "Failed",
    ]);
  });

  it("decodes invoice with lock window in seconds", async () => {
    const d = await new RlnWallet(acct()).decodeInvoice("x");
    expect(d).toMatchObject({
      paymentHash: HASH,
      amtMsat: 3000000n,
      assetAmount: 1000n,
      minFinalCltvExpiryDelta: 42,
      lockSeconds: 25200,
    });
    expect(d.expiresAt).toBe(new Date((1791587083 + 3600) * 1000).toISOString());
  });

  it("refuses amounts below 3,000,000 msat before calling the node", async () => {
    const create = vi.fn();
    const w = new RlnWallet(acct({ createHodlInvoice: create }));
    await expect(
      w.createHodlInvoice({
        paymentHash: HASH,
        assetId: "rgb:abc",
        assetAmount: 1n,
        amtMsat: 2_999_999n,
        expirySec: 60,
      }),
    ).rejects.toMatchObject({ code: "WALLET_AMOUNT_TOO_SMALL" });
    expect(create).not.toHaveBeenCalled();
  });

  it("claim passes snake_case body; bad hex rejected", async () => {
    const claim = vi.fn(async () => ({ changed: true }));
    const w = new RlnWallet(acct({ claimHodlInvoice: claim }));
    expect(await w.claimHodlInvoice(HASH, "ab".repeat(32))).toEqual({ changed: true });
    expect(claim).toHaveBeenCalledWith({ payment_hash: HASH, payment_preimage: "ab".repeat(32) });
    await expect(w.claimHodlInvoice("zz", "ab".repeat(32))).rejects.toMatchObject({
      code: "WALLET_INVALID_INPUT",
    });
  });

  it("times out a hung call as WALLET_TIMEOUT", async () => {
    const w = new RlnWallet(acct({ sign: () => new Promise(() => {}) }), { callTimeoutMs: 20 });
    await expect(w.signMessage("m")).rejects.toMatchObject({ code: "WALLET_TIMEOUT" });
  });

  it("emits an immediately failed payment (ROUTE_NOT_FOUND) so the ledger can release", async () => {
    const w = new RlnWallet(
      acct({ sendPayment: async () => ({ status: "Failed", failure_code: "ROUTE_NOT_FOUND" }) }),
    );
    const events: PaymentStatusEvent[] = [];
    w.onPaymentStatus((e) => events.push(e));
    const r = await w.pay("lnbcrt1x");
    expect(r).toMatchObject({ status: "Failed", failureCode: "ROUTE_NOT_FOUND" });
    expect(events).toEqual([
      { paymentHash: HASH, status: "Failed", role: "payer", failureCode: "ROUTE_NOT_FOUND" },
    ]);
    await w.close();
  });
  it("paymentStatus asks the node when it has no watch (restart): a payment the node knows is reported, NotFound means never seen, other errors do not read as never seen", async () => {
    const known = new RlnWallet(acct({ getPayment: async () => ({ status: "Pending" }) }));
    expect(await known.paymentStatus(HASH)).toEqual([
      { paymentHash: HASH, status: "Pending", role: "payer" },
    ]);
    await known.close();
    const none = new RlnWallet(
      acct({
        getPayment: async () => {
          throw new Error("Rln(NotFound): payment");
        },
      }),
    );
    await expect(none.paymentStatus(HASH)).rejects.toMatchObject({ code: "WALLET_INVALID_INPUT" });
    const down = new RlnWallet(
      acct({
        getPayment: async () => {
          throw new Error("connection refused");
        },
      }),
    );
    await expect(down.paymentStatus(HASH)).rejects.toMatchObject({ code: "WALLET_NODE_ERROR" });
  });
  it("polls: payee Claimable then Settled, payer Failed with failure code", async () => {
    let inv = "Pending";
    let pay = "Pending";
    const w = new RlnWallet(
      acct({
        getInvoiceStatus: async () => ({ status: inv }),
        getPayment: async () => ({
          status: pay,
          failure_code: pay === "Failed" ? "RECIPIENT_REJECTED" : null,
        }),
      }),
    );
    const ev: PaymentStatusEvent[] = [];
    await w.createHodlInvoice({
      paymentHash: HASH,
      assetId: "rgb:abc",
      assetAmount: 1000n,
      amtMsat: 3_000_000n,
      expirySec: 60,
    });
    await w.pay("lnbcrt1x");
    w.onPaymentStatus((e) => ev.push(e));
    await w.pollOnce();
    inv = "Claimable";
    await w.pollOnce();
    inv = "Claiming";
    await w.pollOnce(); // maps to Claimable: no new event
    inv = "Succeeded";
    pay = "Failed";
    await w.pollOnce();
    await w.close();
    expect(
      ev.map((e) => `${e.role}:${e.status}${e.failureCode ? `:${e.failureCode}` : ""}`),
    ).toEqual([
      "payee:Pending",
      "payee:Claimable",
      "payee:Settled",
      "payer:Failed:RECIPIENT_REJECTED",
    ]);
  });
});
