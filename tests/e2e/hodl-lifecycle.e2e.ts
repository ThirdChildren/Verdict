// Real regtest e2e (no agents): HODL lifecycle through WalletClient -> wallet daemons, with the engine's real SQLite
// ledger and authorizePaymentChecks. One regtest env at a time. The daemons own the nodes and the channel (ADR-023):
//   pnpm demo:reset && pnpm test:e2e      (or pnpm preflight)
// Daemons: buyer http://127.0.0.1:7411, worker http://127.0.0.1:7412.

import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveDataDir } from "../../packages/identity/src/data-dir.js";
import {
  type PaymentStatusEvent,
  toEngineInvoice,
  WalletClient,
} from "../../packages/wallet/src/index.js";
import { Ledger } from "../../services/capability-engine/src/ledger/index.js";
import {
  authorizePaymentChecks,
  type PaymentCheckContext,
} from "../../services/capability-engine/src/policy/index.js";
import * as k from "../../services/capability-engine/src/policy/testkit.js";

const BASE = join(resolveDataDir(), "regtest");
const { assetId } = JSON.parse(readFileSync(join(BASE, "shared", "asset.json"), "utf8")) as {
  assetId: string;
};
const precision = 2;

const AMT_MSAT = 3_000_000n; // verified minimum for an RGB HTLC (P0.3)
const UNITS = 100n; // 1.00 tUSD at precision 2
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let buyer: WalletClient;
let worker: WalletClient;
let ledger: Ledger;
const buyerEvents: PaymentStatusEvent[] = [];
const workerEvents: PaymentStatusEvent[] = [];
const T0 = new Date(); // ledger timestamps only

const caps = {
  root: { ...k.root, asset_id: assetId, max_total: "50.00", max_per_task: "50.00" },
  child: { ...k.child, asset_id: assetId, max_total: "50.00", max_payments: 10 },
};

async function waitEvent(
  list: PaymentStatusEvent[],
  hash: string,
  status: string,
  role: string,
  ms = 90_000,
) {
  for (let t = 0; t < ms; t += 250) {
    if (list.some((e) => e.paymentHash === hash && e.status === status && e.role === role)) return;
    await sleep(250);
  }
  throw new Error(
    `timeout waiting for ${role} ${status}; saw ${JSON.stringify(list.filter((e) => e.paymentHash === hash))}`,
  );
}

function fresh() {
  const preimage = randomBytes(32);
  return {
    preimage: preimage.toString("hex"),
    hash: createHash("sha256").update(preimage).digest("hex"),
  };
}

async function newInvoice(hash: string) {
  return worker.createHodlInvoice({
    paymentHash: hash,
    assetId,
    assetAmount: UNITS,
    amtMsat: AMT_MSAT,
    expirySec: 3600,
  });
}

function checks(
  decoded: Awaited<ReturnType<WalletClient["decodeInvoice"]>>,
  workerNode: string,
  taskOverride: { deadlineSec: number; maxLockSeconds: number },
  now = new Date(),
) {
  const contract = {
    ...k.contract,
    payment: {
      ...k.contract.payment,
      asset_id: assetId,
      amount: "1.00",
      payment_hash: decoded.paymentHash,
      payee_node_id: workerNode,
    },
    task: {
      ...k.contract.task,
      deadline: new Date(now.getTime() + taskOverride.deadlineSec * 1000).toISOString(),
      max_verify_seconds: 60,
    },
    max_lock_seconds: taskOverride.maxLockSeconds,
    safety_margin_seconds: 60,
  };
  const ctx: PaymentCheckContext = { ...k.payCtx, now, remaining: ledger.remaining(k.CHILD_HASH) };
  return {
    contract,
    decision: authorizePaymentChecks(
      caps.child,
      toEngineInvoice(decoded, now),
      UNITS,
      contract,
      ctx,
    ),
  };
}

beforeAll(async () => {
  buyer = new WalletClient({ baseUrl: process.env.BUYER_WALLET_URL ?? "http://127.0.0.1:7411" });
  worker = new WalletClient({ baseUrl: process.env.WORKER_WALLET_URL ?? "http://127.0.0.1:7412" });
  try {
    await buyer.init();
    await worker.init();
  } catch (e) {
    throw new Error(
      `Wallet daemons are not running (${e instanceof Error ? e.message : String(e)}). Run: pnpm demo:reset`,
    );
  }
  if ((await buyer.assetBalance(assetId)).offchainOutbound < 10n * UNITS)
    throw new Error("Buyer has no usable tUSD channel. Run: pnpm demo:reset");
  ledger = Ledger.open(":memory:", precision);
  ledger.registerCapability(caps.root, k.PARENT_HASH);
  ledger.registerCapability(caps.child, k.CHILD_HASH, k.PARENT_HASH);
  // wallet events are the only thing that moves reservations (invariant 3)
  buyer.onPaymentStatus((e) => {
    buyerEvents.push(e);
    if (e.role === "payer") ledger.applyPaymentStatus(e.paymentHash, e.status, new Date());
  });
  worker.onPaymentStatus((e) => workerEvents.push(e));
}, 400_000);

afterAll(async () => {
  await buyer?.close();
  await worker?.close();
  ledger?.close();
});

describe("HODL lifecycle on real regtest", () => {
  it("run 1: create -> authorize -> reserve -> pay -> Claimable -> claim -> Settled (reserved -> committed)", async () => {
    const before = await buyer.assetBalance(assetId);
    const { preimage, hash } = fresh();
    const inv = await newInvoice(hash);
    const decoded = await buyer.decodeInvoice(inv.bolt11);
    expect(decoded.amtMsat).toBe(AMT_MSAT);
    expect(decoded.assetAmount).toBe(UNITS);
    expect(decoded.assetId).toBe(assetId);
    console.log(
      "run1 decoded: delta",
      decoded.minFinalCltvExpiryDelta,
      "lock s",
      decoded.lockSeconds,
    );

    const { decision } = checks(decoded, await worker.nodeId(), {
      deadlineSec: 300,
      maxLockSeconds: 86_400,
    });
    expect(decision).toEqual({ ok: true });
    const res = ledger.reserve({
      capHash: k.CHILD_HASH,
      taskId: "t1",
      paymentHash: hash,
      amount: UNITS,
      now: T0,
    });
    expect(res.state).toBe("reserved");

    const paid = await buyer.pay(inv.bolt11);
    console.log("run1 pay:", paid.status, paid.failureCode);
    await waitEvent(workerEvents, hash, "Claimable", "payee");
    expect(ledger.getByPaymentHash(hash)?.state).toBe("reserved");

    expect((await worker.claimHodlInvoice(hash, preimage)).changed).toBeDefined();
    await waitEvent(workerEvents, hash, "Settled", "payee");
    await waitEvent(buyerEvents, hash, "Settled", "payer");
    expect(ledger.getByPaymentHash(hash)?.state).toBe("committed");

    const after = await buyer.assetBalance(assetId);
    expect(before.offchainOutbound - after.offchainOutbound).toBe(UNITS);
    console.log(
      "run1 statuses:",
      JSON.stringify([...buyerEvents, ...workerEvents].filter((e) => e.paymentHash === hash)),
    );
  });

  it("run 2: create -> pay -> Claimable -> cancel -> Failed (reserved -> released)", async () => {
    const { hash } = fresh();
    const inv = await newInvoice(hash);
    const decoded = await buyer.decodeInvoice(inv.bolt11);
    const { decision } = checks(decoded, await worker.nodeId(), {
      deadlineSec: 300,
      maxLockSeconds: 86_400,
    });
    expect(decision).toEqual({ ok: true });
    ledger.reserve({
      capHash: k.CHILD_HASH,
      taskId: "t2",
      paymentHash: hash,
      amount: UNITS,
      now: T0,
    });
    const before = await buyer.assetBalance(assetId);
    await buyer.pay(inv.bolt11);
    await waitEvent(workerEvents, hash, "Claimable", "payee");
    await worker.cancelHodlInvoice(hash);
    await waitEvent(buyerEvents, hash, "Failed", "payer");
    expect(ledger.getByPaymentHash(hash)?.state).toBe("released");
    const failed = buyerEvents.find((e) => e.paymentHash === hash && e.status === "Failed");
    console.log("run2 payer failure code:", failed?.failureCode);
    await sleep(2000);
    expect((await buyer.assetBalance(assetId)).offchainOutbound).toBe(before.offchainOutbound);
  });

  it("run 3: lock window checks use the real decoded min_final_cltv_expiry_delta", async () => {
    const { hash } = fresh();
    const inv = await newInvoice(hash);
    const decoded = await buyer.decodeInvoice(inv.bolt11);
    const lock = decoded.minFinalCltvExpiryDelta * 600;
    const node = await worker.nodeId();
    // deadline far beyond what the lock covers -> too short
    const short = checks(decoded, node, { deadlineSec: lock + 3600, maxLockSeconds: 10 * lock });
    expect(short.decision).toMatchObject({ ok: false, code: "LOCK_WINDOW_TOO_SHORT" });
    // max_lock_seconds smaller than the real lock -> too long
    const long = checks(decoded, node, { deadlineSec: 300, maxLockSeconds: lock - 1 });
    expect(long.decision).toMatchObject({ ok: false, code: "LOCK_WINDOW_TOO_LONG" });
    // boundary: just fits
    const ok = checks(decoded, node, { deadlineSec: lock - 120, maxLockSeconds: lock });
    expect(ok.decision).toEqual({ ok: true });
    console.log("run3 real lock seconds:", lock, short.decision, long.decision);
    // nothing was reserved or paid (cancelHodlInvoice on an unpaid invoice throws "No claimable HTLC found")
    expect(ledger.getByPaymentHash(hash)).toBeUndefined();
  });
});
