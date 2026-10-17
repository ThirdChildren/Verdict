import { describe, expect, it } from "vitest";
import type { ZodType } from "zod";
import * as f from "./fixtures.js";
import {
  acceptanceSchema,
  assertTransition,
  BLOCK_CODES,
  BLOCK_TEMPLATES,
  bodies,
  childCapabilitySchema,
  envelopeSchema,
  offeredContractSchema,
  PROTOCOL_VERSION,
  payeesAttenuate,
  refusalResponseSchema,
  renderBlockMessage,
  rootCapabilitySchema,
  spendIntentSchema,
  TASK_STATES,
  TASK_TRANSITIONS,
  type TaskState,
  taskContractSchema,
  UI_EVENTS_VERSION,
  uiEventSchema,
  verdictRecordSchema,
} from "./index.js";

const intent = {
  kind: "task_payment",
  category: "code",
  counterparty: f.EVM_B,
  amount: "1.20",
  recurring: false,
  interval: null,
  task_spec: "Build a CSV-to-JSON CLI",
  deadline: "2026-10-18T16:15:00Z",
  rationale: "Needed for the demo",
};
const H = f.HASH;
const envBase = {
  v: 0,
  id: "123e4567-e89b-42d3-a456-426614174000",
  task_id: f.verdict.task_id,
  from: f.EVM_A,
  to: f.EVM_B,
  sent_at: "2026-10-18T15:40:00Z",
  sig: f.SIG_EVM,
};
const sealed = `${"A".repeat(106)}==`;
const bodySamples: Record<string, unknown> = {
  CAP_ROOT: f.root,
  CAP_CHILD: f.child,
  TASK_OFFER: { ...f.contract, signatures: { buyer: f.SIG_EVM } },
  TASK_ACCEPT: f.contract,
  P_DEPOSIT: { contract: f.contract, sealed_preimage: sealed },
  P_CONFIRM: {
    task_id: f.verdict.task_id,
    payment_hash: H("f"),
    package_sha256: H("7"),
    confirmed: true,
  },
  HODL_INVOICE: { bolt11: "lnbcrt1abc", payment_hash: H("f") },
  ESCROW_LOCKED: { payment_hash: H("f"), status: "Pending" },
  DELIVER: { attempt: 1, delivery_sha256: H("2"), bundle_b64: "AAAA", self_check_exit_code: 0 },
  VERDICT: f.verdict,
  APPROVE: { task_id: f.verdict.task_id, payment_hash: H("f"), confirmed: true },
  PREIMAGE: { payment_hash: H("f"), preimage_hex: H("a"), reason: "VERDICT_RELEASE" },
  SPEND_INTENT: { cap_hash: H("c"), intent },
  REFUSAL: {
    code: "CHILD_OUTLIVES_PARENT",
    message: "m",
    details: { parent_expires_at: "2026-10-18T00:00:00Z" },
    intent_sha256: H("d"),
  },
  CLAIMED: { payment_hash: H("f") },
  REFUNDED: { payment_hash: H("f") },
  BLOCKED: {
    code: "AMOUNT_EXCEEDS_PER_TASK",
    message: "m",
    intent,
    cap_id: "cap_0123456789abcdef",
  },
};

function roundTrip(schema: ZodType, v: unknown) {
  const parsed = schema.parse(v);
  expect(schema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
  expect(parsed).toEqual(v);
}

describe("round trip", () => {
  it.each([
    ["root", rootCapabilitySchema, f.root],
    ["child", childCapabilitySchema, f.child],
    ["intent", spendIntentSchema, intent],
    ["contract", taskContractSchema, f.contract],
    ["verdict", verdictRecordSchema, f.verdict],
  ] as const)("%s", (_n, s, v) => roundTrip(s, v));

  it("every message body in the catalogue", () => {
    expect(Object.keys(bodySamples).sort()).toEqual(Object.keys(bodies).sort());
    for (const [t, v] of Object.entries(bodySamples))
      roundTrip(bodies[t as keyof typeof bodies], v);
  });
  it("envelopes and UI events", () => {
    for (const t of [
      "SPEND_INTENT",
      "TASK_ACCEPT",
      "P_CONFIRM",
      "DELIVER",
      "VERDICT",
      "PREIMAGE",
    ]) {
      roundTrip(envelopeSchema, { ...envBase, type: t, body: bodySamples[t] });
    }
    roundTrip(uiEventSchema, {
      seq: 1,
      at: "2026-10-18T15:40:00Z",
      type: "BLOCKED",
      data: bodySamples.BLOCKED,
    });
    roundTrip(uiEventSchema, {
      seq: 2,
      at: "2026-10-18T15:40:00Z",
      type: "TASK_STATE",
      data: { task_id: f.verdict.task_id, state: "ESCROW_LOCKED" },
    });
    roundTrip(uiEventSchema, {
      seq: 3,
      at: "2026-10-18T15:40:00Z",
      type: "PAYMENT_CONFIRMING",
      data: { task_id: f.verdict.task_id, payment_hash: f.HASH("a") },
    });
    expect(
      uiEventSchema.safeParse({
        seq: 3,
        at: "2026-10-18T15:40:00Z",
        type: "PAYMENT_CONFIRMING",
        data: { task_id: f.verdict.task_id, payment_hash: f.HASH("a"), x: 1 },
      }).success,
    ).toBe(false);
  });
  it("offer needs only the buyer signature, accept needs both", () => {
    const offer = { ...f.contract, signatures: { buyer: f.SIG_EVM } };
    expect(offeredContractSchema.safeParse(offer).success).toBe(true);
    expect(taskContractSchema.safeParse(offer).success).toBe(false);
  });
});

describe("rejection", () => {
  const bad = (s: ZodType, v: unknown) => expect(s.safeParse(v).success).toBe(false);
  it("extra fields everywhere", () => {
    bad(rootCapabilitySchema, { ...f.root, extra: 1 });
    bad(childCapabilitySchema, { ...f.child, extra: 1 });
    bad(spendIntentSchema, { ...intent, extra: 1 });
    bad(taskContractSchema, { ...f.contract, extra: 1 });
    bad(taskContractSchema, { ...f.contract, payment: { ...f.contract.payment, extra: 1 } });
    bad(taskContractSchema, {
      ...f.contract,
      signatures: { ...f.contract.signatures, extra: "x" },
    });
    bad(verdictRecordSchema, { ...f.verdict, extra: 1 });
    bad(envelopeSchema, { ...envBase, type: "CLAIMED", body: { payment_hash: H("f") }, extra: 1 });
    bad(envelopeSchema, { ...envBase, type: "CLAIMED", body: { payment_hash: H("f"), extra: 1 } });
  });
  it("float, negative, exponent and short amounts", () => {
    for (const amount of [1.2, "1.2e0", "-1.00", "1", "0.00", "01.20", " 1.20"]) {
      bad(spendIntentSchema, { ...intent, amount });
    }
    bad(rootCapabilitySchema, { ...f.root, max_total: 5 });
  });
  it("bad hex and wrong lengths", () => {
    bad(verdictRecordSchema, { ...f.verdict, delivery_sha256: "ABC" });
    bad(verdictRecordSchema, { ...f.verdict, delivery_sha256: "F".repeat(64) });
    bad(verdictRecordSchema, { ...f.verdict, payment_hash: "f".repeat(63) });
    bad(verdictRecordSchema, { ...f.verdict, timestamp: 1.5 });
    bad(verdictRecordSchema, { ...f.verdict, timestamp: "2026-10-18T15:40:00Z" });
    bad(taskContractSchema, {
      ...f.contract,
      payment: { ...f.contract.payment, payee_node_id: `04${"9".repeat(64)}` },
    });
    bad(taskContractSchema, { ...f.contract, buyer: `eip191:0x${"A".repeat(40)}` });
    bad(taskContractSchema, { ...f.contract, buyer: `ed25519:${"a".repeat(63)}` });
    bad(taskContractSchema, { ...f.contract, signatures: { buyer: "0x12", worker: f.SIG_EVM } });
    bad(bodies.P_DEPOSIT, { contract: f.contract, sealed_preimage: "AAAA" });
    bad(bodies.PREIMAGE, {
      payment_hash: H("f"),
      preimage_hex: "g".repeat(64),
      reason: "VERDICT_RELEASE",
    });
    bad(bodies.P_CONFIRM, { ...(bodySamples.P_CONFIRM as object), confirmed: false });
  });
  it("capability invariants in the schema", () => {
    bad(rootCapabilitySchema, { ...f.root, recurring: true });
    bad(childCapabilitySchema, { ...f.child, recurring: true });
    bad(childCapabilitySchema, { ...f.child, counterparties: "preapproved_workers" });
    bad(rootCapabilitySchema, { ...f.root, parent: f.root.cap_id });
    bad(childCapabilitySchema, { ...f.child, parent: f.root.cap_id }); // must be the full sha256
    bad(childCapabilitySchema, { ...f.child, max_payments: 0 });
    bad(rootCapabilitySchema, { ...f.root, expires_at: "2026-10-18 17:00:00" });
    bad(rootCapabilitySchema, { ...f.root, expires_at: "2026-10-18T17:00:00+02:00" });
  });
  it("envelope: wrong version, unknown type, bad uuid, mismatched body", () => {
    const ok = { ...envBase, type: "CLAIMED", body: { payment_hash: H("f") } };
    expect(envelopeSchema.safeParse(ok).success).toBe(true);
    bad(envelopeSchema, { ...ok, v: 1 });
    bad(envelopeSchema, { ...ok, type: "NOPE" });
    bad(envelopeSchema, { ...ok, id: "not-a-uuid" });
    bad(envelopeSchema, { ...ok, type: "VERDICT" });
  });
});

describe("catalogue, states, version", () => {
  it("all 25 block codes render when given params", () => {
    expect(BLOCK_CODES).toHaveLength(26);
    for (const c of BLOCK_CODES) {
      const names = [...BLOCK_TEMPLATES[c].matchAll(/\{([a-z_]+)\}/g)].map((m) => m[1] as string);
      const params = Object.fromEntries(names.map((n) => [n, "X"]));
      const msg = (renderBlockMessage as (c: string, p: object) => string)(c, params);
      expect(msg).not.toMatch(/[{}]/);
    }
  });
  it("spec example message", () => {
    expect(renderBlockMessage("AMOUNT_EXCEEDS_PER_TASK", { amount: "3.00", max: "2.00" })).toBe(
      "The agent asked to pay 3.00 tUSD, but your mandate allows at most 2.00 tUSD per task. Nothing was signed and no funds moved.",
    );
    expect(() =>
      (renderBlockMessage as (c: string, p: object) => string)("AMOUNT_EXCEEDS_PER_TASK", {
        amount: "3.00",
      }),
    ).toThrow();
  });
  it("transitions", () => {
    const path = [
      "DRAFT",
      "MANDATE_SIGNED",
      "CHILD_DERIVED",
      "OFFERED",
      "ACCEPTED",
      "P_DEPOSITED",
      "P_CONFIRMED",
      "INVOICE_RECEIVED",
      "ESCROW_LOCKED",
      "DELIVERED",
      "VERDICT_WITHHOLD",
      "DELIVERED",
      "VERDICT_RELEASE",
      "CLAIMED",
    ] as const;
    for (let i = 1; i < path.length; i++)
      assertTransition(path[i - 1] as TaskState, path[i] as TaskState);
    assertTransition("VERDICT_WITHHOLD", "EXPIRED");
    assertTransition("EXPIRED", "REFUNDED");
    assertTransition("ESCROW_LOCKED", "APPROVED");
    assertTransition("APPROVED", "CLAIMED");
    for (const s of TASK_STATES.slice(0, 8)) assertTransition(s, "BLOCKED");
    expect(() => assertTransition("ESCROW_LOCKED", "BLOCKED")).toThrow();
    expect(() => assertTransition("CLAIMED", "REFUNDED")).toThrow();
    expect(() => assertTransition("DRAFT", "ESCROW_LOCKED")).toThrow();
    expect(() => assertTransition("VERDICT_RELEASE", "REFUNDED")).toThrow();
    for (const s of TASK_STATES) expect(TASK_TRANSITIONS[s]).toBeDefined();
  });
  it("versions", () => {
    expect(PROTOCOL_VERSION).toBe("0.1.3");
    expect(UI_EVENTS_VERSION).toBe("0.4.0");
  });
  it("lock window codes exist, old HTLC_EXPIRY codes are gone", () => {
    expect(BLOCK_CODES).toContain("LOCK_WINDOW_TOO_SHORT");
    expect(BLOCK_CODES).toContain("LOCK_WINDOW_TOO_LONG");
    expect(BLOCK_CODES.join()).not.toContain("HTLC_EXPIRY");
  });
  it("EXPIRED is only reachable from lock-holding states", () => {
    const from = TASK_STATES.filter((s) => TASK_TRANSITIONS[s].includes("EXPIRED"));
    expect(from.sort()).toEqual(["ESCROW_LOCKED", "VERDICT_WITHHOLD"]);
  });
});

describe("0.1.1 additions", () => {
  it("refusal and acceptance responses", () => {
    roundTrip(refusalResponseSchema, { ok: false, ...(bodySamples.REFUSAL as object) });
    roundTrip(acceptanceSchema, { ok: true, cap_id: "cap_0123456789abcdef" });
    expect(acceptanceSchema.safeParse({ ok: true, extra: 1 }).success).toBe(false);
    expect(
      bodies.REFUSAL.safeParse({ ...(bodySamples.REFUSAL as object), code: "NOPE" }).success,
    ).toBe(false);
  });
  it("CHILD_OUTLIVES_PARENT renders", () => {
    expect(
      renderBlockMessage("CHILD_OUTLIVES_PARENT", {
        child_expires_at: "a",
        parent_expires_at: "b",
      }),
    ).toContain("longer than the mandate");
  });
});

describe("0.1.2 allowed_payees", () => {
  const bad = (s: ZodType, v: unknown) => expect(s.safeParse(v).success).toBe(false);
  it("is required and non-empty on root and child", () => {
    const { allowed_payees: _a, ...r } = f.root;
    const { allowed_payees: _b, ...c } = f.child;
    expect(rootCapabilitySchema.safeParse(r).success).toBe(false);
    expect(childCapabilitySchema.safeParse(c).success).toBe(false);
    bad(rootCapabilitySchema, { ...f.root, allowed_payees: [] });
    bad(childCapabilitySchema, { ...f.child, allowed_payees: [] });
  });
  it("payeesAttenuate enforces subset", () => {
    expect(payeesAttenuate(f.root, f.child)).toEqual({ ok: true });
    const other = `eip191:0x${"c".repeat(40)}`;
    expect(payeesAttenuate(f.root, { allowed_payees: [f.EVM_B, other] })).toEqual({
      ok: false,
      payee: other,
    });
  });
});
