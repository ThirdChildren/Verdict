// MOCK DATA: stand-ins for the engine REST endpoints, used only with ?mock=1 (banner is visible).
import { contractHash, dirHash, type VerdictRecord } from "@verdict/protocol";
import {
  ApiError,
  type Chain,
  type Evidence,
  type GoalResponse,
  type SignedMandate,
  type TaskList,
} from "../lib/api.js";
import { useStore } from "../store.js";

const TASK = "task_0123456789abcdef";
const t0 = Date.now();

export async function newTask(): Promise<string> {
  return "mock".repeat(16);
}
export async function submitTaskGoal(): Promise<void> {}

export async function fetchEvidence(taskId: string): Promise<Evidence> {
  const contract = { mock: true, task: "csv2json", price: "1.20", signature: "0xmock" };
  const files = [
    {
      path: "out.json",
      content:
        '[\n  {"name": "Ada", "age": 36},\n  {"name": "Grace", "age": 45},\n  {"name": "Linus", "age": 28}\n]',
    },
  ];
  const dh = dirHash(
    files.map((f) => ({ path: f.path, bytes: new TextEncoder().encode(f.content) })),
  );
  const verdict: VerdictRecord = {
    task_id: taskId,
    contract_sha256: contractHash(contract),
    delivery_sha256: dh,
    verifier_package_sha256: "3".repeat(64),
    attempt: 1,
    checks: [{ id: "parses-header", status: "PASS" }],
    exit_code: 0,
    verdict: "RELEASE",
    payment_hash: "f".repeat(64),
    timestamp: 1792338060,
    verifier_sig: "2".repeat(128),
  };
  return {
    task_id: taskId,
    contract,
    contract_sha256: contractHash(contract),
    delivery: { files, sha256: dh },
    verdict,
  };
}

/** Same formula as the engine: expires_at_height = locked height + cltv blocks (invoice delta + observed margin). */
const MOCK_LOCKED_AT = 100;
const MOCK_INVOICE_DELTA = 80;
const MOCK_MARGIN = 14;
const MOCK_CLTV = MOCK_INVOICE_DELTA + MOCK_MARGIN;

export async function fetchChain(): Promise<Chain> {
  const height = MOCK_LOCKED_AT + Math.floor((Date.now() - t0) / 2000);
  return {
    height,
    payments: [
      {
        task_id: TASK,
        payment_hash: "f".repeat(64),
        locked_at_height: MOCK_LOCKED_AT,
        expires_at_height: MOCK_LOCKED_AT + MOCK_CLTV,
      },
    ],
  };
}

export async function fetchTasks(): Promise<TaskList> {
  return {
    tasks: [{ task_id: TASK, description: "Convert a CSV file into JSON", amount: "1.20" }],
  };
}

// Mock signing: the wizard is explorable with ?mock=1 but nothing is signed.
const MOCK_WORKER = `02${"ab".repeat(32)}`;
export async function proposeMandate(goal: string): Promise<GoalResponse> {
  const stated = /\d/.test(goal);
  const flags = stated
    ? []
    : [
        {
          code: "AMOUNT_NOT_IN_TEXT",
          message: "The mandate allows 5.00 tUSD but your text never mentions that amount.",
        },
      ];
  return {
    ok: true,
    mandate: {
      max_total: "5.00",
      max_per_task: "2.00",
      expires_at: new Date(Date.now() + 12 * 3_600_000).toISOString(),
      allowed_payees: [MOCK_WORKER],
      payee_names: { [MOCK_WORKER]: "worker" },
      allowed_categories: ["data-conversion"],
      recurring: false,
      flags,
      needs_second_confirm: flags.length > 0,
    },
    flags,
    needs_second_confirm: flags.length > 0,
  };
}

export async function signAndInstall(
  goal: string,
  second: boolean,
  token?: string,
): Promise<SignedMandate> {
  if (!/\d/.test(goal) && !second && !token)
    throw new ApiError(
      "SECOND_CONFIRM_REQUIRED",
      "This mandate looks unusual: an amount in it does not appear in what you wrote. Please confirm a second time before it is signed.",
      "mock-token",
    );
  return { capHash: "cap_mock0123456789ab".padEnd(64, "0"), signature: "5".repeat(128) };
}

/** Mock "Mine until refund": canned progress on the store, nothing is mined. */
export async function mineUntilRefund(taskId: string): Promise<void> {
  const [from, to] = [MOCK_LOCKED_AT, MOCK_LOCKED_AT + MOCK_CLTV];
  let h = from;
  const tick = () => {
    h = Math.min(to, h + 12);
    useStore.getState().setMine({
      task_id: taskId,
      height: h,
      target_height: to,
      percent: Math.round(((h - from) / (to - from)) * 100),
      state: h >= to ? "refunded" : "mining",
    });
    if (h < to) setTimeout(tick, 400);
  };
  tick();
}
