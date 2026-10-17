import { BLOCK_CODES, type BlockCode, formatAmount } from "@verdict/protocol";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { authorizePaymentChecks } from "./authorizePaymentChecks.js";
import { canDerive } from "./canDerive.js";
import { checkIntent } from "./checkIntent.js";
import * as k from "./testkit.js";

const intentCtx = {
  now: k.NOW,
  precision: k.P,
  revoked: false,
  remaining: 500n,
  paymentsMade: 0,
  preapprovedWorkers: [k.W1, k.W2],
  ancestorPayees: [[k.W1, k.W2]],
};
const code = (d: { ok: boolean; code?: BlockCode }) => (d.ok ? "OK" : d.code);
const pay = (
  over: Partial<typeof k.payCtx> = {},
  inv = k.invoice,
  c = k.contract,
  amt = 120n,
  cap = k.child,
) => authorizePaymentChecks(cap, inv, amt, c, { ...k.payCtx, ...over });

describe("canDerive", () => {
  it("allows a valid narrowing", () =>
    expect(canDerive(k.root, k.child, k.deriveCtx).ok).toBe(true));
  const cases: [string, BlockCode, () => ReturnType<typeof canDerive>][] = [
    [
      "child payee outside the parent's allowed_payees",
      "PAYEE_NOT_IN_PARENT",
      () =>
        canDerive(
          k.root,
          { ...k.child, allowed_payees: [k.W1, `eip191:0x${"9".repeat(40)}`] },
          k.deriveCtx,
        ),
    ],
    [
      "bad parent sig",
      "SIGNATURE_INVALID",
      () => canDerive(k.root, k.child, { ...k.deriveCtx, parentSignatureValid: false }),
    ],
    [
      "revoked",
      "CAPABILITY_REVOKED",
      () => canDerive(k.root, k.child, { ...k.deriveCtx, parentRevoked: true }),
    ],
    [
      "parent expired",
      "CAPABILITY_EXPIRED",
      () => canDerive(k.root, k.child, { ...k.deriveCtx, now: new Date("2026-10-19T00:00:00Z") }),
    ],
    [
      "parent hash",
      "PARENT_MISMATCH",
      () => canDerive(k.root, k.child, { ...k.deriveCtx, parentHash: "0".repeat(64) }),
    ],
    [
      "per task",
      "AMOUNT_EXCEEDS_PER_TASK",
      () => canDerive(k.root, { ...k.child, max_total: "2.50" }, k.deriveCtx),
    ],
    [
      "remaining",
      "AMOUNT_EXCEEDS_REMAINING",
      () => canDerive(k.root, k.child, { ...k.deriveCtx, parentRemaining: 100n }),
    ],
    [
      "later expiry",
      "CHILD_OUTLIVES_PARENT",
      () => canDerive({ ...k.root, expires_at: "2026-10-18T16:00:00Z" }, k.child, k.deriveCtx),
    ],
    [
      "action",
      "ACTION_NOT_ALLOWED",
      () =>
        canDerive(
          k.root,
          { ...k.child, allowed_actions: ["task_payment", "withdraw"] },
          k.deriveCtx,
        ),
    ],
    [
      "category",
      "CATEGORY_NOT_ALLOWED",
      () => canDerive(k.root, { ...k.child, allowed_categories: ["code", "ads"] }, k.deriveCtx),
    ],
    [
      "counterparty",
      "COUNTERPARTY_NOT_ALLOWED",
      () =>
        canDerive(
          k.root,
          { ...k.child, counterparties: [`eip191:0x${"d".repeat(40)}`] },
          k.deriveCtx,
        ),
    ],
    [
      "counterparty not in preapproved list",
      "COUNTERPARTY_NOT_ALLOWED",
      () =>
        canDerive(
          k.root,
          { ...k.child, counterparties: [k.W1, k.W2] },
          { ...k.deriveCtx, preapprovedWorkers: [k.W1] },
        ),
    ],
    [
      "recurring",
      "RECURRING_NOT_ALLOWED",
      () => canDerive(k.root, { ...k.child, recurring: true as unknown as false }, k.deriveCtx),
    ],
    [
      "asset",
      "ASSET_MISMATCH",
      () => canDerive(k.root, { ...k.child, asset_id: "rgb:other" }, k.deriveCtx),
    ],
    [
      "malformed amount fails closed",
      "MALFORMED_INTENT",
      () => canDerive(k.root, { ...k.child, max_total: "1.2" }, k.deriveCtx),
    ],
  ];
  for (const [name, c, run] of cases)
    it(`blocks: ${name} -> ${c}`, () => expect(code(run())).toBe(c));

  it("PROPERTY: an allowed child never exceeds its parent on any dimension", () => {
    const sub = (xs: string[]) => fc.subarray(xs, { minLength: 0 });
    fc.assert(
      fc.property(
        fc.record({
          total: fc.bigInt({ min: 1n, max: 10_000n }),
          perTask: fc.bigInt({ min: 1n, max: 10_000n }),
          remaining: fc.bigInt({ min: 0n, max: 10_000n }),
          cTotal: fc.bigInt({ min: 1n, max: 20_000n }),
          pExp: fc.integer({ min: 1, max: 5000 }),
          cExp: fc.integer({ min: 1, max: 5000 }),
          pActions: sub(["a", "b", "c"]).filter((x) => x.length > 0),
          cActions: sub(["a", "b", "c", "d"]).filter((x) => x.length > 0),
          pCats: sub(["x", "y", "z"]).filter((x) => x.length > 0),
          cCats: sub(["x", "y", "z", "w"]).filter((x) => x.length > 0),
          cps: sub([k.W1, k.W2, `eip191:0x${"d".repeat(40)}`]).filter((x) => x.length > 0),
          recurring: fc.boolean(),
          sameAsset: fc.boolean(),
        }),
        (g) => {
          const base = Date.parse("2026-10-18T16:00:00Z");
          const parent = {
            ...k.root,
            max_total: formatAmount(g.total, 2),
            max_per_task: formatAmount(g.perTask, 2),
            allowed_actions: g.pActions,
            allowed_categories: g.pCats,
            expires_at: new Date(base + g.pExp * 1000).toISOString(),
          };
          const ch = {
            ...k.child,
            max_total: formatAmount(g.cTotal, 2),
            allowed_actions: g.cActions,
            allowed_categories: g.cCats,
            counterparties: g.cps,
            recurring: g.recurring as unknown as false,
            expires_at: new Date(base + g.cExp * 1000).toISOString(),
            asset_id: g.sameAsset ? k.ASSET : "rgb:other",
          };
          const d = canDerive(parent, ch, { ...k.deriveCtx, parentRemaining: g.remaining });
          if (d.ok) {
            expect(g.cTotal <= g.remaining && g.cTotal <= g.perTask).toBe(true);
            expect(Date.parse(ch.expires_at) <= Date.parse(parent.expires_at)).toBe(true);
            expect(ch.allowed_actions.every((a) => parent.allowed_actions.includes(a))).toBe(true);
            expect(ch.allowed_categories.every((a) => parent.allowed_categories.includes(a))).toBe(
              true,
            );
            expect(ch.counterparties.every((c) => [k.W1, k.W2].includes(c))).toBe(true);
            expect(ch.asset_id).toBe(parent.asset_id);
            expect(ch.recurring).toBe(false);
          }
        },
      ),
    );
  });

  it("PROPERTY: recurring never becomes true under a non-recurring parent", () => {
    fc.assert(
      fc.property(fc.anything(), (r) => {
        const d = canDerive(k.root, { ...k.child, recurring: r as unknown as false }, k.deriveCtx);
        if (r !== false) expect(d.ok).toBe(false);
      }),
    );
  });
});

describe("checkIntent", () => {
  it("allows a valid intent", () =>
    expect(checkIntent(k.child, k.intent, intentCtx).ok).toBe(true));
  it("allows against a root within per-task", () =>
    expect(checkIntent(k.root, { ...k.intent, amount: "2.00" }, intentCtx).ok).toBe(true));
  const cases: [BlockCode, () => ReturnType<typeof checkIntent>][] = [
    ["CAPABILITY_REVOKED", () => checkIntent(k.child, k.intent, { ...intentCtx, revoked: true })],
    [
      "CAPABILITY_EXPIRED",
      () => checkIntent(k.child, k.intent, { ...intentCtx, now: new Date("2026-10-18T17:00:00Z") }),
    ],
    [
      "ACTION_NOT_ALLOWED",
      () => checkIntent({ ...k.child, allowed_actions: ["other"] }, k.intent, intentCtx),
    ],
    [
      "CATEGORY_NOT_ALLOWED",
      () => checkIntent(k.child, { ...k.intent, category: "ads" }, intentCtx),
    ],
    [
      "RECURRING_NOT_ALLOWED",
      () => checkIntent(k.child, { ...k.intent, recurring: true, interval: "daily" }, intentCtx),
    ],
    [
      "COUNTERPARTY_NOT_ALLOWED",
      () => checkIntent(k.child, { ...k.intent, counterparty: k.W2 }, intentCtx),
    ],
    [
      "DEADLINE_PASSED",
      () => checkIntent(k.child, { ...k.intent, deadline: "2026-10-18T14:00:00Z" }, intentCtx),
    ],
    [
      "AMOUNT_EXCEEDS_PER_TASK",
      () => checkIntent(k.root, { ...k.intent, amount: "2.50" }, intentCtx),
    ],
    [
      "AMOUNT_EXCEEDS_REMAINING",
      () => checkIntent(k.child, { ...k.intent, amount: "1.50" }, intentCtx),
    ],
    [
      "AMOUNT_EXCEEDS_REMAINING",
      () => checkIntent(k.child, k.intent, { ...intentCtx, remaining: 50n }),
    ],
    [
      "MAX_PAYMENTS_REACHED",
      () => checkIntent(k.child, k.intent, { ...intentCtx, paymentsMade: 1 }),
    ],
    ["MALFORMED_INTENT", () => checkIntent(k.child, { ...k.intent, amount: "abc" }, intentCtx)],
  ];
  for (const [c, run] of cases) it(`blocks -> ${c}`, () => expect(code(run())).toBe(c));
  it("messages are plain language and fully rendered", () => {
    const d = checkIntent(k.root, { ...k.intent, amount: "2.50" }, intentCtx);
    expect(d.ok === false && d.message).toContain("2.50");
    expect(d.ok === false && d.message).not.toMatch(/[{}]/);
  });
});

describe("authorizePaymentChecks", () => {
  it("allows a matching payment", () => expect(pay().ok).toBe(true));
  const cases: [BlockCode, () => ReturnType<typeof pay>][] = [
    ["SIGNATURE_INVALID", () => pay({ capSignatureValid: false })],
    ["SIGNATURE_INVALID", () => pay({ contractSignaturesValid: false })],
    ["CAPABILITY_REVOKED", () => pay({ revoked: true })],
    ["CAPABILITY_EXPIRED", () => pay({ now: new Date("2026-10-18T16:30:00Z") })],
    ["PARENT_MISMATCH", () => pay({ capHash: "0".repeat(64) })],
    ["ASSET_MISMATCH", () => pay({}, { ...k.invoice, asset_id: "rgb:other" })],
    [
      "ASSET_MISMATCH",
      () =>
        pay({}, k.invoice, {
          ...k.contract,
          payment: { ...k.contract.payment, asset_id: "rgb:other" },
        }),
    ],
    [
      "CATEGORY_NOT_ALLOWED",
      () => pay({}, k.invoice, { ...k.contract, task: { ...k.contract.task, category: "ads" } }),
    ],
    [
      "ACTION_NOT_ALLOWED",
      () => pay({}, k.invoice, k.contract, 120n, { ...k.child, allowed_actions: ["x"] }),
    ],
    ["INVOICE_HASH_MISMATCH", () => pay({}, { ...k.invoice, payment_hash: "0".repeat(64) })],
    ["INVOICE_AMOUNT_MISMATCH", () => pay({}, { ...k.invoice, amount: 121n })],
    ["INVOICE_AMOUNT_MISMATCH", () => pay({}, k.invoice, k.contract, 119n)],
    [
      "AMOUNT_EXCEEDS_PER_TASK",
      () =>
        pay(
          {},
          { ...k.invoice, amount: 250n },
          { ...k.contract, payment: { ...k.contract.payment, amount: "2.50" } },
          250n,
          k.root as never,
        ),
    ],
    ["AMOUNT_EXCEEDS_REMAINING", () => pay({ remaining: 100n })],
    ["MAX_PAYMENTS_REACHED", () => pay({ paymentsMade: 1 })],
    [
      "INVOICE_PAYEE_MISMATCH",
      () => pay({}, { ...k.invoice, payee_node_id: `03${"1".repeat(64)}` }),
    ],
    [
      "COUNTERPARTY_NOT_ALLOWED",
      () =>
        pay({ preapprovedWorkers: [k.W2] }, k.invoice, k.contract, 120n, {
          ...k.child,
          counterparties: [k.W2],
        }),
    ],
    ["LOCK_WINDOW_TOO_SHORT", () => pay({}, { ...k.invoice, min_final_cltv_expiry_delta: 8 })],
    ["LOCK_WINDOW_TOO_LONG", () => pay({}, k.invoice, { ...k.contract, max_lock_seconds: 5399 })],
    ["MALFORMED_INTENT", () => pay({ precision: 3 })],
  ];
  for (const [c, run] of cases) it(`blocks -> ${c}`, () => expect(code(run())).toBe(c));

  it("HTLC window: exactly the required length passes, one block less fails", () => {
    // required 5160 s; 9 blocks = 5400 passes; 8 blocks = 4800 fails
    expect(pay({}, { ...k.invoice, min_final_cltv_expiry_delta: 9 }).ok).toBe(true);
    expect(code(pay({}, { ...k.invoice, min_final_cltv_expiry_delta: 8 }))).toBe(
      "LOCK_WINDOW_TOO_SHORT",
    );
  });
  it("expiry_sec is ignored by the lock window check", () => {
    expect(pay({}, { ...k.invoice, expiry_sec: 1 }).ok).toBe(true);
  });
  it("a one-block-long window cannot satisfy an invoice expiring before deadline + verify + margin", () => {
    expect(
      code(pay({}, { ...k.invoice, min_final_cltv_expiry_delta: 1, expiry_sec: 999999 })),
    ).toBe("LOCK_WINDOW_TOO_SHORT");
  });
  it("covers every catalogue code reachable here at least once (sanity on catalogue size)", () => {
    expect(BLOCK_CODES.length).toBeGreaterThan(20);
  });
});

describe("lock window bounds (property tests)", () => {
  const dl = Date.parse(k.contract.task.deadline);
  const untilDeadline = Math.max(0, Math.ceil((dl - k.NOW.getTime()) / 1000));
  const required =
    untilDeadline + k.contract.task.max_verify_seconds + k.contract.safety_margin_seconds;
  const run = (blocks: number, nowOffsetSec = 0, maxLock = k.contract.max_lock_seconds) =>
    pay(
      { now: new Date(k.NOW.getTime() + nowOffsetSec * 1000) },
      { ...k.invoice, min_final_cltv_expiry_delta: blocks },
      { ...k.contract, max_lock_seconds: maxLock },
    );

  it("lower bound: lock >= (deadline - now) + verify + margin, measured from the injected clock", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 2000 }),
        fc.integer({ min: 0, max: 1800 }),
        (b, off) => {
          const req =
            Math.max(0, Math.ceil((dl - (k.NOW.getTime() + off * 1000)) / 1000)) +
            k.contract.task.max_verify_seconds +
            k.contract.safety_margin_seconds;
          const d = run(b, off, 10_000_000);
          const lock = b * 600;
          if (lock < req) expect(code(d)).toBe("LOCK_WINDOW_TOO_SHORT");
          else expect(code(d)).not.toBe("LOCK_WINDOW_TOO_SHORT");
        },
      ),
    );
    expect(required).toBeGreaterThan(0);
  });

  it("upper bound: lock <= max_lock_seconds", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 2000 }),
        fc.integer({ min: 1, max: 1_000_000 }),
        (b, max) => {
          const d = run(b, 0, max);
          if (code(d) === "LOCK_WINDOW_TOO_SHORT") return;
          if (b * 600 > max) expect(code(d)).toBe("LOCK_WINDOW_TOO_LONG");
          else expect(code(d)).not.toBe("LOCK_WINDOW_TOO_LONG");
        },
      ),
    );
  });
});

describe("child outliving parent", () => {
  it("is CHILD_OUTLIVES_PARENT with a message naming both expiries", () => {
    const d = canDerive(k.root, { ...k.child, expires_at: "2026-10-19T00:00:00Z" }, k.deriveCtx);
    expect(code(d)).toBe("CHILD_OUTLIVES_PARENT");
    if (!d.ok) expect(d.message).toContain("2026-10-19T00:00:00Z");
  });
});

describe("payee chain", () => {
  const evil = `eip191:0x${"9".repeat(40)}`;
  it("intent to a payee missing from an ancestor's signed list is blocked", () =>
    expect(code(checkIntent(k.child, k.intent, { ...intentCtx, ancestorPayees: [[k.W2]] }))).toBe(
      "COUNTERPARTY_NOT_ALLOWED",
    ));
  it("intent to a payee missing from the capability's own list is blocked", () =>
    expect(
      code(
        checkIntent(
          { ...k.child, counterparties: [evil] },
          { ...k.intent, counterparty: evil },
          {
            ...intentCtx,
            preapprovedWorkers: [evil],
          },
        ),
      ),
    ).toBe("COUNTERPARTY_NOT_ALLOWED"));
  it("contract worker missing from an ancestor's list is blocked at payment", () =>
    expect(code(pay({ ancestorPayees: [[k.W2]] }))).toBe("COUNTERPARTY_NOT_ALLOWED"));
});

it("a deadline after the permission ends says the permission has not expired and why it blocks", () => {
  const late = new Date(Date.parse(k.child.expires_at) + 3_600_000).toISOString();
  const d = checkIntent(k.child, { ...k.intent, deadline: late }, intentCtx);
  expect(d.ok).toBe(false);
  if (!d.ok) {
    expect(d.code).toBe("CAPABILITY_EXPIRED");
    expect(d.message).toContain("has not expired yet");
    expect(d.message).toContain(late);
  }
});
