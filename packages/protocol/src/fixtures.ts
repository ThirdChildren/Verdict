import type { ChildCapability, RootCapability, TaskContract, VerdictRecord } from "./index.js";

const H = (c: string) => c.repeat(64);
export const EVM_A = `eip191:0x${"a".repeat(40)}`;
export const EVM_B = `eip191:0x${"b".repeat(40)}`;
export const ED_V = `ed25519:${"c".repeat(64)}`;
export const SIG_EVM = `0x${"1".repeat(130)}`;
export const SIG_ED = "2".repeat(128);
export const ASSET = "rgb:2dkSTbr-jFhznbPmo-TQafzswCN-av4gTsJjX-ttx6CNou5-M98k8Zd";

export const root: RootCapability = {
  version: "verdict-cap/0",
  cap_id: "cap_0123456789abcdef",
  issuer: EVM_A,
  subject: "buyer-agent-01",
  asset_id: ASSET,
  max_total: "5.00",
  max_per_task: "2.00",
  allowed_actions: ["task_payment"],
  allowed_categories: ["code"],
  counterparties: "preapproved_workers",
  allowed_payees: [EVM_B],
  recurring: false,
  expires_at: "2026-10-18T17:00:00Z",
  parent: null,
  signature: SIG_EVM,
};

export const child: ChildCapability = {
  version: "verdict-cap/0",
  cap_id: "cap_fedcba9876543210",
  parent: H("d"), // = capabilityHash(root) in real use
  issuer: EVM_A,
  subject: "buyer-agent-01",
  asset_id: ASSET,
  max_total: "1.20",
  allowed_actions: ["task_payment"],
  allowed_categories: ["code"],
  counterparties: [EVM_B],
  allowed_payees: [EVM_B],
  max_payments: 1,
  recurring: false,
  expires_at: "2026-10-18T16:20:00Z",
  signature: SIG_EVM,
};

export const contract: TaskContract = {
  version: "verdict-task/0",
  buyer: EVM_A,
  worker: EVM_B,
  capability_hash: H("e"),
  payment: {
    asset_id: ASSET,
    amount: "1.20",
    payment_hash: H("f"),
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
    public_id: ED_V,
    endpoint: "http://192.168.1.10:7404",
    package_sha256: H("7"),
    entrypoint: "./verify.sh",
    rule: "EXIT_0_AND_SCHEMA_VALID",
  },
  max_lock_seconds: 86400,
  safety_margin_seconds: 600,
  intent_sha256: H("5"),
  signatures: { buyer: SIG_EVM, worker: SIG_EVM },
};

export const verdict: VerdictRecord = {
  task_id: "task_0123456789abcdef",
  contract_sha256: H("1"),
  delivery_sha256: H("2"),
  verifier_package_sha256: H("7"),
  attempt: 1,
  checks: [
    { id: "tests", status: "PASS" },
    { id: "schema", status: "PASS" },
  ],
  exit_code: 0,
  verdict: "RELEASE",
  payment_hash: H("f"),
  timestamp: 1760790000,
  verifier_sig: SIG_ED,
};
export const HASH = H;
