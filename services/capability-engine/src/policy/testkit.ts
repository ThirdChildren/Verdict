// Test-only fixtures (protocol fixtures are not exported from @verdict/protocol).
import type { ChildCapability, RootCapability, SpendIntent, TaskContract } from "@verdict/protocol";
import type { DecodedInvoice } from "@verdict/wallet/types";
import type { PaymentCheckContext } from "./authorizePaymentChecks.js";
import type { DeriveContext } from "./canDerive.js";

export const P = 2;
export const A = `eip191:0x${"a".repeat(40)}`;
export const W1 = `eip191:0x${"b".repeat(40)}`;
export const W2 = `eip191:0x${"c".repeat(40)}`;
export const ASSET = "rgb:2dkSTbr-jFhznbPmo-TQafzswCN-av4gTsJjX-ttx6CNou5-M98k8Zd";
export const SIG = `0x${"1".repeat(130)}`;
export const NOW = new Date("2026-10-18T15:00:00Z");
export const PARENT_HASH = "d".repeat(64);
export const CHILD_HASH = "e".repeat(64);

export const root: RootCapability = {
  version: "verdict-cap/0",
  cap_id: "cap_0123456789abcdef",
  issuer: A,
  subject: "buyer-agent-01",
  asset_id: ASSET,
  max_total: "5.00",
  max_per_task: "2.00",
  allowed_actions: ["task_payment"],
  allowed_categories: ["code"],
  counterparties: "preapproved_workers",
  allowed_payees: [W1, W2],
  recurring: false,
  expires_at: "2026-10-18T17:00:00Z",
  parent: null,
  signature: SIG,
};
export const child: ChildCapability = {
  version: "verdict-cap/0",
  cap_id: "cap_fedcba9876543210",
  parent: PARENT_HASH,
  issuer: A,
  subject: "buyer-agent-01",
  asset_id: ASSET,
  max_total: "1.20",
  allowed_actions: ["task_payment"],
  allowed_categories: ["code"],
  counterparties: [W1],
  allowed_payees: [W1],
  max_payments: 1,
  recurring: false,
  expires_at: "2026-10-18T16:20:00Z",
  signature: SIG,
};
export const intent: SpendIntent = {
  kind: "task_payment",
  category: "code",
  counterparty: W1,
  amount: "1.20",
  recurring: false,
  interval: null,
  task_spec: "Build a CSV-to-JSON CLI",
  deadline: "2026-10-18T16:15:00Z",
  rationale: "needed",
};
export const contract: TaskContract = {
  version: "verdict-task/0",
  buyer: A,
  worker: W1,
  capability_hash: CHILD_HASH,
  intent_sha256: "a".repeat(64),
  payment: {
    asset_id: ASSET,
    amount: "1.20",
    payment_hash: "f".repeat(64),
    payee_node_id: `02${"9".repeat(64)}`,
    expiry_blocks: 24,
    expiry_seconds: 3600,
  },
  task: {
    category: "code",
    spec: "Build a CSV-to-JSON CLI",
    deadline: "2026-10-18T16:15:00Z",
    max_verify_seconds: 60,
  },
  verifier: {
    public_id: `ed25519:${"c".repeat(64)}`,
    endpoint: "http://192.168.1.10:7404",
    package_sha256: "7".repeat(64),
    entrypoint: "./verify.sh",
    rule: "EXIT_0_AND_SCHEMA_VALID",
  },
  max_lock_seconds: 86400,
  safety_margin_seconds: 600,
  signatures: { buyer: SIG, worker: SIG },
};
// deadline is 75 min away: required = 4500 + 60 + 600 = 5160 s -> 9 blocks (5400 s)
export const invoice: DecodedInvoice = {
  payment_hash: "f".repeat(64),
  amount: 120n,
  asset_id: ASSET,
  payee_node_id: `02${"9".repeat(64)}`,
  min_final_cltv_expiry_delta: 9,
  expiry_sec: 3600,
};
export const deriveCtx: DeriveContext = {
  now: NOW,
  precision: P,
  parentSignatureValid: true,
  parentRevoked: false,
  parentHash: PARENT_HASH,
  parentRemaining: 500n,
  preapprovedWorkers: [W1, W2],
};
export const payCtx: PaymentCheckContext = {
  now: NOW,
  precision: P,
  capSignatureValid: true,
  contractSignaturesValid: true,
  revoked: false,
  capHash: CHILD_HASH,
  remaining: 120n,
  paymentsMade: 0,
  preapprovedWorkers: [W1, W2],
  ancestorPayees: [[W1, W2]],
};
