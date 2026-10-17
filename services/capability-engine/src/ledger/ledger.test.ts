import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BlockError } from "../policy/decision.js";
import * as k from "../policy/testkit.js";
import { Ledger } from "./ledger.js";

let dir: string;
let ledger: Ledger;
const NOW = new Date("2026-10-18T15:00:00Z");
const ph = (n: number) => n.toString(16).padStart(64, "0");
const req = (n: number, amount: bigint, cap = k.CHILD_HASH) => ({
  capHash: cap,
  taskId: `task_${n.toString(16).padStart(16, "0")}`,
  paymentHash: ph(n),
  amount,
  now: NOW,
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ledger-"));
  ledger = Ledger.open(join(dir, "l.db"), k.P);
  ledger.registerCapability(k.root, k.PARENT_HASH);
  ledger.registerCapability(
    { ...k.child, max_total: "3.00", max_payments: 10 },
    k.CHILD_HASH,
    k.PARENT_HASH,
  );
});
afterEach(() => {
  ledger.close();
  rmSync(dir, { recursive: true, force: true });
});

const blockCode = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    return e instanceof BlockError ? e.code : "OTHER";
  }
  return "NONE";
};

describe("ledger lifecycle", () => {
  it("reserve reduces remaining on cap and root", () => {
    ledger.reserve(req(1, 120n));
    expect(ledger.remaining(k.CHILD_HASH)).toBe(180n);
    expect(ledger.remaining(k.PARENT_HASH)).toBe(380n);
  });
  it("failed payment -> released, budget returns", () => {
    ledger.reserve(req(1, 120n));
    expect(ledger.applyPaymentStatus(ph(1), "Failed", NOW)?.state).toBe("released");
    expect(ledger.remaining(k.CHILD_HASH)).toBe(300n);
  });
  it("HTLC fail-back while pending/claimable -> released", () => {
    ledger.reserve(req(1, 120n));
    ledger.applyPaymentStatus(ph(1), "Pending", NOW);
    ledger.applyPaymentStatus(ph(1), "Claimable", NOW);
    expect(ledger.get(1)?.state).toBe("reserved");
    expect(ledger.applyPaymentStatus(ph(1), "Failed", NOW)?.state).toBe("released");
  });
  it("claim (Settled) -> committed and stays committed; replays are idempotent", () => {
    ledger.reserve(req(1, 120n));
    expect(ledger.applyPaymentStatus(ph(1), "Settled", NOW)?.state).toBe("committed");
    expect(ledger.applyPaymentStatus(ph(1), "Settled", NOW)?.state).toBe("committed");
    expect(ledger.remaining(k.CHILD_HASH)).toBe(180n);
    expect(() => ledger.transition(1, "released", NOW)).toThrow();
  });
  it("released is terminal", () => {
    ledger.reserve(req(1, 120n));
    ledger.transition(1, "released", NOW);
    expect(() => ledger.transition(1, "committed", NOW)).toThrow();
  });
  it("unknown payment hash is ignored", () => {
    expect(ledger.applyPaymentStatus(ph(99), "Failed", NOW)).toBeUndefined();
  });
});

describe("ledger limits", () => {
  it("rejects over-budget on the cap", () => {
    expect(blockCode(() => ledger.reserve(req(1, 301n)))).toBe("AMOUNT_EXCEEDS_REMAINING");
  });
  it("rejects over-budget on the root even if the child has room", () => {
    ledger.registerCapability(
      { ...k.child, cap_id: "cap_1111111111111111", max_total: "2.00" },
      "9".repeat(64),
      k.PARENT_HASH,
    );
    ledger.reserve(req(1, 300n));
    ledger.reserve(req(2, 150n, "9".repeat(64)));
    expect(blockCode(() => ledger.reserve(req(3, 51n, "9".repeat(64))))).toBe(
      "AMOUNT_EXCEEDS_REMAINING",
    );
  });
  it("enforces max_payments", () => {
    ledger.registerCapability(k.child, "8".repeat(64), k.PARENT_HASH);
    ledger.reserve(req(1, 10n, "8".repeat(64)));
    expect(blockCode(() => ledger.reserve(req(2, 10n, "8".repeat(64))))).toBe(
      "MAX_PAYMENTS_REACHED",
    );
  });
  it("revoked, unknown and non-positive are refused", () => {
    expect(blockCode(() => ledger.reserve(req(1, 0n)))).toBe("MALFORMED_INTENT");
    expect(blockCode(() => ledger.reserve(req(1, 10n, "0".repeat(64))))).toBe("PARENT_MISMATCH");
    ledger.revoke(k.CHILD_HASH);
    expect(blockCode(() => ledger.reserve(req(1, 10n)))).toBe("CAPABILITY_REVOKED");
  });
  it("duplicate payment hash cannot be reserved twice", () => {
    ledger.reserve(req(1, 10n));
    expect(() => ledger.reserve(req(1, 10n))).toThrow();
    expect(ledger.remaining(k.CHILD_HASH)).toBe(290n);
  });
  it("large 18-digit amounts do not overflow", () => {
    const l = Ledger.open(join(dir, "big.db"), 18);
    const big = {
      ...k.root,
      max_total: "9.000000000000000000",
      max_per_task: "9.000000000000000000",
    };
    l.registerCapability(big, "a".repeat(64));
    l.reserve({
      capHash: "a".repeat(64),
      taskId: "task_0000000000000001",
      paymentHash: ph(1),
      amount: 4_000_000_000_000_000_000n,
      now: NOW,
    });
    l.reserve({
      capHash: "a".repeat(64),
      taskId: "task_0000000000000002",
      paymentHash: ph(2),
      amount: 4_000_000_000_000_000_000n,
      now: NOW,
    });
    expect(l.remaining("a".repeat(64))).toBe(1_000_000_000_000_000_000n);
    l.close();
  });
});

describe("ledger concurrency", () => {
  it("two simultaneous reserves that together exceed the budget -> exactly one succeeds", async () => {
    // two separate connections to the same file, started together
    const other = Ledger.open(join(dir, "l.db"), k.P);
    const run = (l: Ledger, n: number) => Promise.resolve().then(() => l.reserve(req(n, 200n)));
    const results = await Promise.allSettled([run(ledger, 1), run(other, 2)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect(ledger.remaining(k.CHILD_HASH)).toBe(100n);
    other.close();
  });
  it("many parallel reserves across connections never overspend", async () => {
    const conns = [
      ledger,
      Ledger.open(join(dir, "l.db"), k.P),
      Ledger.open(join(dir, "l.db"), k.P),
    ];
    const jobs = Array.from({ length: 40 }, (_, i) =>
      Promise.resolve().then(() => conns[i % 3]!.reserve(req(i + 1, 50n))),
    );
    const res = await Promise.allSettled(jobs);
    expect(res.filter((r) => r.status === "fulfilled")).toHaveLength(6); // 300 / 50
    expect(ledger.remaining(k.CHILD_HASH)).toBe(0n);
    for (const c of conns.slice(1)) c.close();
  });
});

describe("reservations never expire on a timer", () => {
  it("stays reserved and counted however much time passes until a wallet event", () => {
    ledger.reserve(req(1, 100n));
    const later = new Date(NOW.getTime() + 365 * 86_400_000);
    ledger.applyPaymentStatus(ph(1), "Pending", later);
    expect(ledger.getByPaymentHash(ph(1))?.state).toBe("reserved");
    expect(ledger.remaining(k.CHILD_HASH)).toBe(200n);
  });
});

describe("intent uniqueness", () => {
  it("the same intent_sha256 never reserves twice", () => {
    const a = ledger.reserve({ ...req(1, 120n), intentSha256: "aa" });
    const b = ledger.reserve({ ...req(2, 120n), intentSha256: "aa" });
    expect(b.id).toBe(a.id);
    expect(ledger.remaining(k.CHILD_HASH)).toBe(180n);
    expect(ledger.paymentsMade(k.CHILD_HASH)).toBe(1);
  });
  it("remembers the first answer for an intent", () => {
    ledger.rememberIntentResult("bb", { status: 200, body: { ok: true } }, NOW);
    ledger.rememberIntentResult("bb", { status: 422, body: { ok: false } }, NOW);
    expect(ledger.intentResult("bb")).toEqual({ status: 200, body: { ok: true } });
  });
});
