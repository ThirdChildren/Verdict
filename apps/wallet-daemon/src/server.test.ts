import { FakeHub, FakeWallet, WalletClient, WalletError } from "@verdict/wallet";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildWalletServer } from "./server.js";

const ASSET = "rgb:test-asset";
const hub = new FakeHub();
const buyerW = new FakeWallet(`02${"01".repeat(32)}`, hub);
const workerW = new FakeWallet(`02${"02".repeat(32)}`, hub);
buyerW.setBalance(ASSET, 5000n);
const apps: FastifyInstance[] = [];
let buyer: WalletClient;
let worker: WalletClient;

async function serve(wallet: FakeWallet, role: "buyer" | "worker") {
  const app = await buildWalletServer({ wallet, role });
  await app.listen({ port: 0, host: "127.0.0.1" });
  apps.push(app);
  const addr = app.server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return new WalletClient({ baseUrl: `http://127.0.0.1:${port}`, timeoutMs: 3000 });
}

beforeAll(async () => {
  buyer = await serve(buyerW, "buyer");
  worker = await serve(workerW, "worker");
});
afterAll(async () => {
  await buyer.close();
  await worker.close();
  for (const a of apps) await a.close();
});

const waitFor = async (f: () => boolean) => {
  for (let i = 0; i < 100 && !f(); i++) await new Promise((r) => setTimeout(r, 20));
  expect(f()).toBe(true);
};

describe("wallet daemon over HTTP", () => {
  it("after a daemon restart (empty memory) answers a payment status from the wallet, 404 only for a hash it never saw", async () => {
    const hub2 = new FakeHub();
    const w1 = new FakeWallet(`02${"03".repeat(32)}`, hub2);
    const w2 = new FakeWallet(`02${"04".repeat(32)}`, hub2);
    w1.setBalance(ASSET, 1000n);
    const hash = "cd".repeat(32);
    const inv = await w2.createHodlInvoice({
      paymentHash: hash,
      assetId: ASSET,
      assetAmount: 10n,
      amtMsat: 3_000_000n,
      expirySec: 3600,
    });
    await w1.pay(inv.bolt11); // paid before this daemon "started": the daemon never saw it
    const c = await serve(w1, "buyer");
    expect((await c.paymentStatus(hash)).some((e) => e.role === "payer")).toBe(true);
    await expect(c.paymentStatus("ef".repeat(32))).rejects.toMatchObject({
      code: "WALLET_INVALID_INPUT",
    });
    await c.close();
  });

  it("serves health, node id and bigint balance as decimal strings", async () => {
    await buyer.init();
    expect(await buyer.nodeId()).toBe(`02${"01".repeat(32)}`);
    expect((await buyer.assetBalance(ASSET)).offchainOutbound).toBeTypeOf("bigint");
  });

  it("runs the HODL lifecycle through the client and streams events", async () => {
    const events: string[] = [];
    const off = worker.onPaymentStatus((e) => events.push(`${e.role}:${e.status}`));
    await new Promise((r) => setTimeout(r, 150)); // let the socket connect
    const hash = "ab".repeat(32);
    const inv = await worker.createHodlInvoice({
      paymentHash: hash,
      assetId: ASSET,
      assetAmount: 100n,
      amtMsat: 3_000_000n,
      expirySec: 3600,
    });
    const dec = await buyer.decodeInvoice(inv.bolt11);
    expect(dec.assetAmount).toBe(100n);
    expect(dec.lockSeconds).toBe(dec.minFinalCltvExpiryDelta * 600);
    const paid = await buyer.pay(inv.bolt11);
    expect(paid.paymentHash).toBe(hash);
    await waitFor(() => events.includes("payee:Claimable"));
    const st = await worker.paymentStatus(hash);
    expect(st.some((s) => s.status === "Claimable")).toBe(true);
    await worker.cancelHodlInvoice(hash);
    await waitFor(() => events.includes("payee:Failed"));
    off();
  });

  it("maps wallet and validation errors to codes, and unknown hashes to an error", async () => {
    await expect(
      worker.createHodlInvoice({
        paymentHash: "XYZ",
        assetId: ASSET,
        assetAmount: 1n,
        amtMsat: 3_000_000n,
        expirySec: 60,
      }),
    ).rejects.toMatchObject({ code: "WALLET_INVALID_INPUT" });
    await expect(worker.cancelHodlInvoice("nothex")).rejects.toMatchObject({
      code: "WALLET_INVALID_INPUT",
    });
    await expect(worker.paymentStatus("ef".repeat(32))).rejects.toBeInstanceOf(WalletError);
  });

  it("fails closed with WALLET_NODE_ERROR when the daemon is down", async () => {
    const dead = new WalletClient({ baseUrl: "http://127.0.0.1:1", timeoutMs: 500 });
    await expect(dead.nodeId()).rejects.toMatchObject({ code: "WALLET_NODE_ERROR" });
  });
});

describe("localOnly", () => {
  it("answers the loopback Host and refuses a foreign Host or any browser Origin", async () => {
    const app = await buildWalletServer({
      wallet: buyerW,
      role: "buyer",
      localOnly: { port: 7411, uiOrigins: [] },
    });
    const get = (headers: Record<string, string>) =>
      app.inject({ method: "GET", url: "/v0/health", headers });
    expect((await get({ host: "127.0.0.1:7411" })).statusCode).toBe(200);
    expect((await get({ host: "evil.example:7411" })).statusCode).toBe(403);
    expect(
      (await get({ host: "127.0.0.1:7411", origin: "http://localhost:5173" })).statusCode,
    ).toBe(403);
    await app.close();
  });
});
