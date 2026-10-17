// MOCK DATA: hand-written stream for UI development only (?mock=1). Never shown without the MOCK DATA banner.
import { capabilityHash, type UiEvent, uiEventSchema } from "@verdict/protocol";

const h = (c: string) => c.repeat(64);
const ASSET = "rgb:2dkSTbr-jFhznbPmo-TQafzswCN-av4gTsJjX-ttx6CNou5-M98k8Zd";
const BUYER = `eip191:0x${"a".repeat(40)}`;
const WORKER = `eip191:0x${"b".repeat(40)}`;
const TASK = "task_0123456789abcdef";
const PH = h("f");
let seq = 0;
// Mandate expiry relative to now: 11 h 42 m left, inside the 24 h hard limit; the task permission lives 90 min.
const inMinutes = (m: number) =>
  new Date(Date.now() + m * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z");
const at = () => new Date(Date.UTC(2026, 9, 18, 15, 40, seq)).toISOString().replace(".000Z", "Z");
const raw = (type: string, data: unknown): unknown => ({ seq: seq++, at: at(), type, data });
const state = (s: string, attempt?: number) =>
  raw("TASK_STATE", { task_id: TASK, state: s, ...(attempt ? { attempt } : {}) });

export const MOCK_WORKER_ID = WORKER;
const ROOT_DATA = {
  version: "verdict-cap/0",
  cap_id: "cap_0123456789abcdef",
  issuer: BUYER,
  subject: "buyer-agent-01",
  asset_id: ASSET,
  max_total: "5.00",
  max_per_task: "2.00",
  allowed_actions: ["task_payment"],
  allowed_categories: ["code"],
  counterparties: "preapproved_workers",
  allowed_payees: [WORKER],
  recurring: false,
  expires_at: inMinutes(11 * 60 + 42),
  parent: null,
  signature: `0x${"1".repeat(130)}`,
};
/** Root hash exactly as the store computes it, so child capabilities point at the real mandate. */
export const MOCK_ROOT_HASH = (() => {
  const e = uiEventSchema.parse({
    seq: 0,
    at: "2026-10-18T15:40:00Z",
    type: "CAP_ROOT",
    data: ROOT_DATA,
  });
  if (e.type !== "CAP_ROOT") throw new Error("mock root missing");
  return capabilityHash(e.data);
})();
const rawEvents: unknown[] = [
  raw("CAP_ROOT", ROOT_DATA),
  state("MANDATE_SIGNED"),
  raw("BUDGET_UPDATED", {
    cap_id: "cap_0123456789abcdef",
    remaining: "5.00",
    reserved: "0.00",
    committed: "0.00",
  }),
  raw("CAP_CHILD", {
    version: "verdict-cap/0",
    cap_id: "cap_fedcba9876543210",
    parent: MOCK_ROOT_HASH,
    issuer: BUYER,
    subject: "buyer-agent-01",
    asset_id: ASSET,
    max_total: "1.20",
    allowed_actions: ["task_payment"],
    allowed_categories: ["code"],
    counterparties: [WORKER],
    allowed_payees: [WORKER],
    max_payments: 1,
    recurring: false,
    expires_at: inMinutes(90),
    signature: `0x${"1".repeat(130)}`,
  }),
  state("CHILD_DERIVED"),
  state("OFFERED"),
  state("ACCEPTED"),
  state("P_DEPOSITED"),
  state("P_CONFIRMED"),
  state("INVOICE_RECEIVED"),
  raw("BUDGET_UPDATED", {
    cap_id: "cap_0123456789abcdef",
    remaining: "3.80",
    reserved: "1.20",
    committed: "0.00",
  }),
  raw("PAYMENT_STATUS", { task_id: TASK, payment_hash: PH, status: "Pending" }),
  state("ESCROW_LOCKED"),
  state("DELIVERED", 1),
  raw("VERDICT", {
    task_id: TASK,
    contract_sha256: h("1"),
    delivery_sha256: h("2"),
    verifier_package_sha256: h("3"),
    attempt: 1,
    checks: [
      { id: "parses-header", status: "PASS" },
      { id: "row-count", status: "PASS" },
      { id: "types", status: "FAIL" },
    ],
    exit_code: 1,
    verdict: "WITHHOLD",
    payment_hash: PH,
    timestamp: 1792338000,
    verifier_sig: "2".repeat(128),
  }),
  state("VERDICT_WITHHOLD", 1),
  state("DELIVERED", 2),
  raw("VERDICT", {
    task_id: TASK,
    contract_sha256: h("1"),
    delivery_sha256: h("4"),
    verifier_package_sha256: h("3"),
    attempt: 2,
    checks: [
      { id: "parses-header", status: "PASS" },
      { id: "row-count", status: "PASS" },
      { id: "types", status: "PASS" },
    ],
    exit_code: 0,
    verdict: "RELEASE",
    payment_hash: PH,
    timestamp: 1792338060,
    verifier_sig: "2".repeat(128),
  }),
  state("VERDICT_RELEASE", 2),
  raw("PAYMENT_STATUS", { task_id: TASK, payment_hash: PH, status: "Claimable" }),
  raw("PAYMENT_STATUS", { task_id: TASK, payment_hash: PH, status: "Settled" }),
  raw("CLAIMED", { payment_hash: PH }),
  raw("BUDGET_UPDATED", {
    cap_id: "cap_0123456789abcdef",
    remaining: "3.80",
    reserved: "0.00",
    committed: "1.20",
  }),
  state("CLAIMED"),
  raw("BLOCKED", {
    code: "AMOUNT_EXCEEDS_PER_TASK",
    message:
      "The agent asked to pay 50.00 tUSD, but your mandate allows at most 2.00 tUSD per task. Nothing was signed and no funds moved.",
    intent: { amount: "50.00" },
    cap_id: "cap_0123456789abcdef",
  }),
];

/** Validated at module load, so mock data can never drift from the schema. */
export const MOCK_EVENTS: UiEvent[] = rawEvents.map((e) => uiEventSchema.parse(e));

/** The one mock mandate: wizard Review, Your mandate and Agents all read from it. */
export const MOCK_ROOT = (() => {
  const e = MOCK_EVENTS.find((x) => x.type === "CAP_ROOT");
  if (!e || e.type !== "CAP_ROOT") throw new Error("mock root missing");
  return e.data;
})();
export const MOCK_PAYEE_NAMES: Record<string, string> = { [WORKER]: "worker" };
