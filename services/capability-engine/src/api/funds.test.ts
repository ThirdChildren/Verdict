import { expect, test } from "vitest";
import { Ledger } from "../ledger/index.js";
import * as k from "../policy/testkit.js";
import { buildServer } from "../server.js";

const PRINCIPAL = `eip191:0x${"a".repeat(40)}`;
const ids = {
  principal: PRINCIPAL,
  engine: `eip191:0x${"b".repeat(40)}`,
  buyer: `eip191:0x${"c".repeat(40)}`,
};
const wallet = (outbound: bigint) =>
  ({
    assetBalance: async () => ({
      settled: 0n,
      future: 0n,
      spendable: 0n,
      offchainOutbound: outbound,
      offchainInbound: 0n,
    }),
    onPaymentStatus: () => () => undefined,
  }) as never;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

async function fundsApp(outbound: bigint, reserve?: bigint) {
  const ledger = Ledger.open(":memory:", k.P);
  if (reserve !== undefined) {
    ledger.registerCapability(k.root, k.PARENT_HASH);
    ledger.registerCapability(k.child, k.CHILD_HASH, k.PARENT_HASH);
    ledger.reserve({
      capHash: k.CHILD_HASH,
      taskId: "task_0000000000000001",
      paymentHash: "1".repeat(64),
      amount: reserve,
      now: k.NOW,
    });
  }
  return buildServer({
    logger: false,
    ledger,
    wallet: wallet(outbound),
    assetId: "rgb:asset",
    identities: ids,
    precision: k.P,
  });
}

test("GET /api/funds: spendable from the channel, reserved from the ledger, available = difference", async () => {
  const app = await fundsApp(5000n, 120n);
  const res = await app.inject({ method: "GET", url: "/api/funds" });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({
    ok: true,
    spendable: "50.00",
    reserved: "1.20",
    available_to_delegate: "48.80",
  });
  await app.close();
});

test("GET /api/funds: available never goes below zero", async () => {
  const app = await fundsApp(100n, 120n);
  const res = await app.inject({ method: "GET", url: "/api/funds" });
  expect(res.json()).toMatchObject({
    spendable: "1.00",
    reserved: "1.20",
    available_to_delegate: "0.00",
  });
  await app.close();
});

test("GET /api/funds: 503 without a wallet, 502 when the wallet fails", async () => {
  const bare = await buildServer({ logger: false, ledger: Ledger.open(":memory:", k.P) });
  const none = await bare.inject({ method: "GET", url: "/api/funds" });
  expect(none.statusCode).toBe(503);
  expect(none.json()).toMatchObject({ ok: false, code: "FUNDS_UNAVAILABLE" });
  const broken = await buildServer({
    logger: false,
    ledger: Ledger.open(":memory:", k.P),
    wallet: {
      assetBalance: async () => {
        throw new Error("down");
      },
      onPaymentStatus: () => () => undefined,
    } as never,
    assetId: "rgb:asset",
  });
  expect((await broken.inject({ method: "GET", url: "/api/funds" })).statusCode).toBe(502);
});

test("GET /api/principal: the id when the signer answers with the trusted key", async () => {
  const seen: string[] = [];
  const app = await buildServer({
    logger: false,
    identities: ids,
    signerUrl: "http://127.0.0.1:7403",
    signerFetch: (async (u: string) => {
      seen.push(u);
      return json({ ok: true, service: "principal-signer", principal: PRINCIPAL });
    }) as never,
  });
  const res = await app.inject({ method: "GET", url: "/api/principal" });
  expect(res.json()).toEqual({ ok: true, id: PRINCIPAL });
  expect(seen).toEqual(["http://127.0.0.1:7403/health"]);
});

test("GET /api/principal: 502 when the signer is down or holds another key", async () => {
  const down = await buildServer({
    logger: false,
    identities: ids,
    signerFetch: (async () => {
      throw new Error("ECONNREFUSED");
    }) as never,
  });
  const a = await down.inject({ method: "GET", url: "/api/principal" });
  expect(a.statusCode).toBe(502);
  expect(a.json()).toMatchObject({ ok: false, code: "PRINCIPAL_SIGNER_DOWN" });
  const other = await buildServer({
    logger: false,
    identities: ids,
    signerFetch: (async () => json({ ok: true, principal: `eip191:0x${"d".repeat(40)}` })) as never,
  });
  const b = await other.inject({ method: "GET", url: "/api/principal" });
  expect(b.json()).toMatchObject({ ok: false, code: "PRINCIPAL_MISMATCH" });
});

test("GET /api/principal: 503 when the engine has no identities", async () => {
  const app = await buildServer({ logger: false });
  expect((await app.inject({ method: "GET", url: "/api/principal" })).statusCode).toBe(503);
});
