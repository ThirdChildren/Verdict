import { createHash, randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { FakeHub, FakeWallet, type PaymentStatusEvent, WalletError } from "./index.js";

const pre = () => randomBytes(32).toString("hex");
const h = (p: string) => createHash("sha256").update(Buffer.from(p, "hex")).digest("hex");
const ASSET = "rgb:fake-tusd";

function pair() {
  const hub = new FakeHub();
  const buyer = new FakeWallet(`02${"01".repeat(32)}`, hub);
  const worker = new FakeWallet(`02${"02".repeat(32)}`, hub);
  buyer.setBalance(ASSET, 5000n);
  return { buyer, worker };
}
const inv = (w: FakeWallet, hash: string, amtMsat = 3_000_000n) =>
  w.createHodlInvoice({
    paymentHash: hash,
    assetId: ASSET,
    assetAmount: 1000n,
    amtMsat,
    expirySec: 3600,
  });

afterEach(() => {
  delete process.env.VERDICT_MODE;
});

describe("FakeWallet port contract", () => {
  it("throws in demo mode", () => {
    process.env.VERDICT_MODE = "demo";
    expect(() => new FakeWallet()).toThrow(WalletError);
  });

  it("create -> pay -> Claimable -> claim -> Settled moves the asset", async () => {
    const { buyer, worker } = pair();
    const ev: PaymentStatusEvent[] = [];
    worker.onPaymentStatus((e) => ev.push(e));
    buyer.onPaymentStatus((e) => ev.push(e));
    const p = pre();
    const { bolt11 } = await inv(worker, h(p));
    const dec = await buyer.decodeInvoice(bolt11);
    expect(dec.lockSeconds).toBe(dec.minFinalCltvExpiryDelta * 600);
    expect(dec.payeeNodeId).toBe(await worker.nodeId());
    await buyer.pay(bolt11);
    expect(await worker.claimHodlInvoice(h(p), p)).toEqual({ changed: true });
    expect(ev.map((e) => `${e.role}:${e.status}`)).toEqual([
      "payee:Claimable",
      "payer:Pending",
      "payee:Settled",
      "payer:Settled",
    ]);
    expect((await worker.assetBalance(ASSET)).settled).toBe(1000n);
    expect((await buyer.assetBalance(ASSET)).settled).toBe(4000n);
  });

  it("rejects a wrong preimage and amounts below the RGB minimum", async () => {
    const { buyer, worker } = pair();
    const p = pre();
    await expect(worker.claimHodlInvoice(h(p), pre())).rejects.toMatchObject({
      code: "WALLET_INVALID_INPUT",
    });
    const { bolt11 } = await inv(worker, h(p), 2_999_999n);
    await expect(buyer.pay(bolt11)).rejects.toMatchObject({ code: "WALLET_AMOUNT_TOO_SMALL" });
  });

  it("cancel gives payer Failed and no asset moves; expiry gives payer Failed", async () => {
    const { buyer, worker } = pair();
    const ev: PaymentStatusEvent[] = [];
    buyer.onPaymentStatus((e) => ev.push(e));
    const p = pre();
    const { bolt11 } = await inv(worker, h(p));
    await buyer.pay(bolt11);
    await worker.cancelHodlInvoice(h(p));
    expect(ev.at(-1)).toMatchObject({ status: "Failed", failureCode: "RECIPIENT_REJECTED" });
    const p2 = pre();
    const i2 = await inv(worker, h(p2));
    await buyer.pay(i2.bolt11);
    worker.expireLock(h(p2));
    expect(ev.at(-1)).toMatchObject({ paymentHash: h(p2), status: "Failed" });
    expect((await buyer.assetBalance(ASSET)).settled).toBe(5000n);
  });

  it("signs per node", async () => {
    const { buyer, worker } = pair();
    expect(await buyer.signMessage("m")).not.toBe(await worker.signMessage("m"));
  });
});
