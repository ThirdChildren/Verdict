// MOCK DATA: canned worker and verifier answers for the Agents panel (?mock=1 only). Nothing is fetched.
import type { VerifierTaskView } from "../lib/verifierApi.js";
import type { WorkerTaskView } from "../lib/workerApi.js";

export const mockWorkerTask = (taskId: string): WorkerTaskView => ({
  taskId,
  state: "DELIVERED",
  progress: { attempt: 3, max_attempts: 3 },
  attempts: [
    { n: 1, seconds: 14.2, tokens_per_sec: 39.8, self_check: "FAIL" },
    { n: 2, seconds: 12.9, tokens_per_sec: 41.1, self_check: "FAIL" },
    { n: 3, seconds: 11.4, tokens_per_sec: 41.7, self_check: "PASS" },
  ],
  toggles: { sabotaged: false, disappears: false },
});

export const mockVerifierTask = (taskId: string): VerifierTaskView => ({
  task_id: taskId,
  payment_hash: "f".repeat(64),
  released: true,
  reports: [
    {
      record: {
        task_id: taskId,
        attempt: 1,
        verdict: "RELEASE",
        exit_code: 0,
        verifier_package_sha256: "3".repeat(64),
        delivery_sha256: "4".repeat(64),
        verifier_sig: "2".repeat(128),
        checks: [
          { id: "parses-header", status: "PASS" },
          { id: "row-count", status: "PASS" },
          { id: "types", status: "PASS" },
        ],
      },
      outcome: "PASS",
      code: null,
      message: "All checks passed.",
      sandbox: "bubblewrap",
      log_tail: ["parses-header: ok", "row-count: 3 of 3", "types: ok", "exit 0"],
      verify_sh_sha256: "5".repeat(64),
      seconds: 0.4,
    },
  ],
});
