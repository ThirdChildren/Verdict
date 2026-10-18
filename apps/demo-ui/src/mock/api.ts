// MOCK DATA: stand-ins for the engine REST endpoints, used only with ?mock=1 (banner is visible).
import { contractHash, dirHash, uiEventSchema, type VerdictRecord } from "@verdict/protocol";
import {
  ApiError,
  type Chain,
  type Evidence,
  type Funds,
  type GoalResponse,
  type SignedMandate,
  type TaskList,
} from "../lib/api.js";
import { fromMinor, toMinor } from "../lib/money.js";
import { MOCK_TASK_TYPES, type TaskType } from "../lib/taskTypes.js";
import { type PackageStats, parseStats } from "../lib/verifierApi.js";
import { useStore } from "../store.js";
import { MOCK_PAYEE_NAMES, MOCK_ROOT, MOCK_WORKER_ID } from "./events.js";

const TASK = "task_0123456789abcdef";
const t0 = Date.now();

export async function fetchVerifierStats(): Promise<PackageStats[]> {
  return parseStats({
    packages: [
      {
        package_sha256: `3f9a${"0".repeat(60)}`,
        package_id: "csv2json-v1",
        format: 1,
        profile: null,
        runs: 12,
        pass: 9,
        pass_rate: 0.75,
        mean_score: null,
        median_duration_ms: 4300,
        determinism_rate: 1,
        self_check_agreement: 0.92,
        checks: [
          { id: "tests", runs: 12, fail_rate: 0.25 },
          { id: "schema", runs: 12, fail_rate: 0.08 },
          { id: "no-network", runs: 12, fail_rate: 0 },
        ],
        withhold_codes: { VERIFY_TIMEOUT: 1 },
      },
      {
        package_sha256: `b71c${"0".repeat(60)}`,
        package_id: "json-normalise-v1",
        format: 2,
        profile: "standard",
        runs: 5,
        pass_rate: 0.8,
        mean_score: 91.2,
        median_duration_ms: 3100,
        determinism_rate: 1,
        self_check_agreement: 1,
        checks: [
          { id: "fixtures", runs: 5, fail_rate: 0.2 },
          { id: "property", runs: 5, fail_rate: 0.2 },
          { id: "spec", runs: 5, fail_rate: 0 },
        ],
        withhold_codes: {},
      },
    ],
  });
}

export async function newTask(): Promise<string> {
  return "mock".repeat(16);
}
export async function submitTaskGoal(goal = ""): Promise<void> {
  // The buyer agent only accepts work a hashed package can verify; here that is anything about CSV or JSON.
  if (!/csv|json/i.test(goal)) throw new ApiError("TASK_NOT_VERIFIABLE", MOCK_REFUSAL_MESSAGE);
}

export const MOCK_REFUSAL_MESSAGE =
  "Verdict only buys work it can verify. This request does not match any task type available today.";

export async function routeRequest(
  request: string,
): Promise<{ package_id: string; reason: string }> {
  // MOCK DATA: the buyer routes by keyword.
  if (/csv/i.test(request))
    return { package_id: "csv2json-v1", reason: "The request names a CSV conversion." };
  if (/json/i.test(request))
    return { package_id: "json-normalise-v1", reason: "The request names a JSON document." };
  throw new ApiError("TASK_NOT_VERIFIABLE", MOCK_REFUSAL_MESSAGE);
}

export async function fetchTaskTypes(): Promise<TaskType[]> {
  return MOCK_TASK_TYPES;
}

export async function fetchEvidence(taskId: string): Promise<Evidence> {
  const contract = { mock: true, task: "csv2json", price: "1.20", signature: "0xmock" };
  const files = [
    {
      path: "out.json",
      content:
        '[\n  {"name": "Ada", "age": "36"},\n  {"name": "Grace", "age": "45"},\n  {"name": "Linus", "age": "28"}\n]',
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
    checks: [{ id: "tests", status: "PASS" }],
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
    intent: {
      kind: "task_payment",
      category: "code",
      counterparty: `eip191:0x${"b".repeat(40)}`,
      amount: "1.20",
      recurring: false,
      interval: null,
      task_spec: "Convert a CSV file into JSON",
      deadline: "2026-10-18T17:00:00Z",
      rationale:
        "The job fits the 1.20 tUSD per-task limit and the worker is on the approved list.",
    },
    intent_sha256: "e".repeat(64),
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

/** MOCK DATA: what GET /api/mandates and GET /api/tasks would return for the active storyboard scene. */
export interface MockHistory {
  mandates: unknown;
  tasks: { task_id: string; description: string; amount: string; root_hash: string }[];
}
let history: MockHistory | null = null;
export function setMockHistory(h: MockHistory | null): void {
  history = h;
}
export async function fetchMandatesJson(): Promise<unknown> {
  return history?.mandates ?? { mandates: [] };
}
export async function fetchTasksJson(): Promise<unknown> {
  return { tasks: history?.tasks ?? (await fetchTasks()).tasks };
}

export async function fetchTasks(): Promise<TaskList> {
  if (history) return { tasks: history.tasks };
  return {
    tasks: [{ task_id: TASK, description: "Convert a CSV file into JSON", amount: "1.20" }],
  };
}

// Mock signing: the wizard is explorable with ?mock=1 but nothing is signed.
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
      max_total: MOCK_ROOT.max_total,
      max_per_task: MOCK_ROOT.max_per_task,
      expires_at: MOCK_ROOT.expires_at,
      allowed_payees: [MOCK_WORKER_ID],
      payee_names: MOCK_PAYEE_NAMES,
      allowed_categories: MOCK_ROOT.allowed_categories,
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
  installMockRoot();
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
    else applyMockRefund(taskId);
  };
  tick();
}

/** MOCK DATA: the signed mandate lands on the screen like the live events would. Nothing is signed or sent. */
function installMockRoot(): void {
  const st = useStore.getState();
  const old = st.root;
  const id = old ? "cap_2222222222222222" : MOCK_ROOT.cap_id;
  const at = new Date().toISOString();
  if (old)
    st.retire({
      cap_hash: id,
      retired: [old.cap_id],
      reason: "The previous mandate was retired. Nothing was paid.",
      at,
    });
  const base = useStore.getState().lastSeq;
  st.setPayeeNames(MOCK_PAYEE_NAMES);
  st.apply(
    uiEventSchema.parse({
      seq: base + 1,
      at,
      type: "CAP_ROOT",
      data: {
        ...MOCK_ROOT,
        cap_id: id,
        expires_at: new Date(Date.parse(MOCK_ROOT.expires_at)).toISOString(),
      },
    }),
  );
  st.apply(
    uiEventSchema.parse({
      seq: base + 2,
      at,
      type: "BUDGET_UPDATED",
      data: { cap_id: id, remaining: MOCK_ROOT.max_total, reserved: "0.00", committed: "0.00" },
    }),
  );
}

/** MOCK DATA: the escrow timed out, so the stage, rail and ledger all show the refund. */
function applyMockRefund(taskId: string): void {
  const st = useStore.getState();
  const t = st.tasks[taskId];
  if (!t || !st.root) return;
  const hash = t.paymentHash ?? "f".repeat(64);
  const at = new Date().toISOString();
  const base = st.lastSeq;
  const b = st.budget;
  st.apply(
    uiEventSchema.parse({
      seq: base + 1,
      at,
      type: "PAYMENT_STATUS",
      data: { task_id: taskId, payment_hash: hash, status: "Failed" },
    }),
  );
  st.apply(
    uiEventSchema.parse({
      seq: base + 2,
      at,
      type: "TASK_STATE",
      data: { task_id: taskId, state: "REFUNDED" },
    }),
  );
  if (b)
    st.apply(
      uiEventSchema.parse({
        seq: base + 3,
        at,
        type: "BUDGET_UPDATED",
        data: {
          cap_id: st.root.cap_id,
          remaining: fromMinor(
            toMinor(b.remaining, st.precision) + toMinor(b.reserved, st.precision),
            st.precision,
          ),
          reserved: fromMinor(0n, st.precision),
          committed: b.committed,
        },
      }),
    );
}

export async function fetchPrincipal(): Promise<{ id: string }> {
  return { id: MOCK_ROOT.issuer };
}
export async function fetchFunds(): Promise<Funds> {
  return { spendable: "50.00", reserved: "1.20", available_to_delegate: "48.80" };
}
