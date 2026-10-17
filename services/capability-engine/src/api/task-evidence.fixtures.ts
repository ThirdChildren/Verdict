// Test-only data: protocol-shaped capability, contract and verdict.
import {
  type ChildCapability,
  contractHash,
  type RootCapability,
  type TaskContract,
  taskId,
  type VerdictRecord,
} from "@verdict/protocol";
import * as k from "../policy/testkit.js";

export function chainFixtures(): {
  root: RootCapability;
  child: ChildCapability;
  contract: TaskContract;
  verdict: VerdictRecord;
} {
  const contract = k.contract;
  const verdict: VerdictRecord = {
    task_id: taskId(contract),
    contract_sha256: contractHash(contract as unknown as Record<string, unknown>),
    delivery_sha256: "2".repeat(64),
    verifier_package_sha256: contract.verifier.package_sha256,
    attempt: 1,
    checks: [{ id: "tests", status: "PASS" }],
    exit_code: 0,
    verdict: "RELEASE",
    payment_hash: contract.payment.payment_hash,
    timestamp: 1760790000,
    verifier_sig: "2".repeat(128),
  };
  return { root: k.root, child: k.child, contract, verdict };
}
