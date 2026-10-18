import { BLOCK_CODES, type BlockCode, verdictRecordSchema } from "@verdict/protocol";
import { z } from "zod";
import * as mock from "../mock/api.js";
import { type Draft, type Installed, installedSchema, parseAuthorAnswer } from "./authoring.js";
import { type MandateRow, parseMandates, parseTaskRoots } from "./mandates.js";
import { isMock } from "./mode.js";
import {
  DEFAULT_TASK_TYPES,
  parseTaskTypes,
  parseVerifierInfo,
  type TaskType,
  type TaskTypeCatalogue,
} from "./taskTypes.js";
import { fetchWorkerDelivery } from "./workerApi.js";

const host = (envPort: string | undefined, def: string, param: string): string => {
  const q = new URLSearchParams(location.search).get(param);
  const env = import.meta.env;
  return q ?? `${env.VITE_ENGINE_HOST ?? location.hostname}:${envPort ?? def}`;
};
export const engineBase = () =>
  `${location.protocol}//${host(import.meta.env.VITE_ENGINE_PORT, "7401", "engine")}`;
// The signer only listens on loopback, so the console must run on the same machine.
const signerBase = () =>
  `http://${new URLSearchParams(location.search).get("signer") ?? `127.0.0.1:${import.meta.env.VITE_SIGNER_PORT ?? "7403"}`}`;
const buyerBase = () =>
  `${location.protocol}//${host(import.meta.env.VITE_BUYER_PORT, "7402", "buyer")}`;

export const flagSchema = z.object({ code: z.string(), message: z.string() });

const payeeSchema = z.union([z.string(), z.object({ name: z.string(), id: z.string() })]);

/** Buyer /api/goal success: flags and needs_second_confirm live inside `mandate`; payees are {name,id}. */
export const goalResponseSchema = z
  .object({
    ok: z.literal(true),
    mandate: z
      .object({
        max_total: z.string(),
        max_per_task: z.string(),
        expires_at: z.string(),
        allowed_payees: z.array(payeeSchema).optional(),
        counterparties: z.union([z.array(z.string()), z.string()]).optional(),
        allowed_categories: z.array(z.string()).optional(),
        summary: z.string().optional(),
        recurring: z.boolean().optional(),
        flags: z.array(flagSchema).default([]),
        needs_second_confirm: z.boolean().default(false),
      })
      .passthrough(),
  })
  .transform((r) => {
    const names: Record<string, string> = {};
    const ids = (r.mandate.allowed_payees ?? []).map((p) => {
      if (typeof p === "string") return p;
      names[p.id] = p.name;
      return p.id;
    });
    return {
      ok: r.ok,
      mandate: { ...r.mandate, allowed_payees: ids, payee_names: names },
      flags: r.mandate.flags,
      needs_second_confirm: r.mandate.needs_second_confirm,
    };
  });
export type GoalResponse = z.infer<typeof goalResponseSchema>;

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    /** Set when the signer asks for a second confirmation (HTTP 428). Single use, 120 s. */
    readonly confirmToken?: string,
    /** Task types listed in a refusal body (`task_types: [{ id, title }]`), when present. */
    readonly taskTypes?: TaskType[],
  ) {
    super(message);
  }
  get blockCode(): BlockCode | null {
    return (BLOCK_CODES as readonly string[]).includes(this.code) ? (this.code as BlockCode) : null;
  }
}

async function post(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  } catch {
    throw new ApiError(
      "UNREACHABLE",
      "The service could not be reached. Nothing was signed and no funds moved.",
    );
  }
  const json: unknown = await res.json().catch(() => null);
  const parsed = z
    .object({
      ok: z.boolean(),
      code: z.string().optional(),
      message: z.string().optional(),
      confirm_token: z.string().optional(),
    })
    .passthrough()
    .safeParse(json);
  if (!parsed.success)
    throw new ApiError(
      "BAD_RESPONSE",
      "The service sent an answer this screen does not understand.",
    );
  if (!parsed.data.ok)
    throw new ApiError(
      parsed.data.code ?? "ERROR",
      parsed.data.message ?? "The request was refused.",
      parsed.data.confirm_token,
      parseTaskTypes(json) ?? undefined,
    );
  return json;
}

export async function proposeMandate(goal: string): Promise<GoalResponse> {
  if (isMock()) return mock.proposeMandate(goal);
  const r = goalResponseSchema.safeParse(await post(`${buyerBase()}/api/goal`, { goal }));
  if (!r.success)
    throw new ApiError("BAD_RESPONSE", "The buyer agent sent a mandate this screen cannot read.");
  return r.data;
}

export interface SignedMandate {
  capHash: string;
  /** The principal's signature over the root capability, as returned by the signer. */
  signature: string;
}

/**
 * The browser holds no keys: the principal-signer signs after the approve click, then the engine installs the root.
 * The signer decides for itself whether the mandate is unusual. If it asks for a second confirmation (428 + token)
 * and the Principal already ticked the box in this dialog, the call is repeated once with that token.
 * Otherwise the ApiError carries the token so the dialog can ask.
 */
export async function signAndInstall(
  goal: string,
  proposal: unknown,
  secondConfirm: boolean,
  token?: string,
): Promise<SignedMandate> {
  if (isMock()) return mock.signAndInstall(goal, secondConfirm, token);
  const sign = (confirm_token?: string) =>
    post(
      `${signerBase()}/sign-root`,
      { goal, proposal, ...(confirm_token ? { confirm_token } : {}) },
      { "x-verdict-ui": "1" },
    );
  let raw: unknown;
  try {
    raw = await sign(token);
  } catch (e) {
    if (!(e instanceof ApiError) || !e.confirmToken || !secondConfirm || token) throw e;
    raw = await sign(e.confirmToken);
  }
  const signed = z
    .object({ root: z.object({ signature: z.string() }).passthrough() })
    .passthrough()
    .parse(raw);
  const done = z
    .object({ cap_hash: z.string() })
    .passthrough()
    .parse(await post(`${engineBase()}/api/mandate`, { root: signed.root }));
  return { capHash: done.cap_hash, signature: signed.root.signature };
}

/** Demo: asks the buyer agent to behave as if compromised. The engine's refusal comes back as `decision`. */
export async function simulateCompromisedAgent(): Promise<{
  code: string | null;
  message: string;
}> {
  const r = z
    .object({
      decision: z
        .object({ status: z.string(), code: z.string().optional(), message: z.string().optional() })
        .passthrough(),
    })
    .passthrough()
    .parse(await post(`${buyerBase()}/api/attack/compromised-agent`, {}));
  return {
    code: r.decision.code ?? null,
    message:
      r.decision.message ??
      (r.decision.status === "FORWARDED"
        ? "The engine accepted the request. That should never happen."
        : "The simulation could not run."),
  };
}

async function getJson(url: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch {
    throw new ApiError("UNREACHABLE", "The engine could not be reached.");
  }
  if (!res.ok) throw new ApiError("HTTP_ERROR", `The engine answered with status ${res.status}.`);
  return res.json().catch(() => null);
}

/** Derives a fresh child capability from the active root. No new signature is needed. */
export async function newTask(
  amount?: string,
  packageId?: string,
  request?: string,
): Promise<string> {
  if (isMock()) return mock.newTask();
  const r = z
    .object({ cap_hash: z.string() })
    .passthrough()
    .parse(
      await post(`${engineBase()}/api/mandate/task`, {
        ...(amount === undefined ? {} : { amount }),
        ...(packageId === undefined ? {} : { package_id: packageId }),
        ...(request === undefined ? {} : { request }),
      }),
    );
  return r.cap_hash;
}

/** Asks the buyer agent which task type a request maps to. A 422 TASK_NOT_VERIFIABLE comes back as an ApiError. */
export async function routeRequest(
  request: string,
): Promise<{ package_id: string; reason: string }> {
  if (isMock()) return mock.routeRequest(request);
  const r = z
    .object({ package_id: z.string(), reason: z.string().optional() })
    .passthrough()
    .safeParse(await post(`${buyerBase()}/api/route`, { request }));
  if (!r.success)
    throw new ApiError(
      "BAD_RESPONSE",
      "The buyer agent sent a routing answer this screen cannot read.",
    );
  return { package_id: r.data.package_id, reason: r.data.reason ?? "" };
}

/** Task types the verifier can check. 404 (older engine): the one package that always existed. */
export async function fetchTaskTypes(): Promise<TaskTypeCatalogue> {
  if (isMock()) return { types: await mock.fetchTaskTypes() };
  let res: Response;
  try {
    res = await fetch(`${engineBase()}/api/task-types`);
  } catch {
    throw new ApiError("UNREACHABLE", "The engine could not be reached.");
  }
  if (res.status === 404) return { types: DEFAULT_TASK_TYPES };
  if (!res.ok) throw new ApiError("HTTP_ERROR", `The engine answered with status ${res.status}.`);
  const raw: unknown = await res.json().catch(() => null);
  const list = parseTaskTypes(raw);
  if (!list)
    throw new ApiError("BAD_RESPONSE", "The engine sent a task-type list this screen cannot read.");
  return { types: list, ...parseVerifierInfo(raw) };
}

/** Sends the goal of a new task to the buyer agent, under the already signed mandate. */
export async function submitTaskGoal(goal: string): Promise<void> {
  if (isMock()) return mock.submitTaskGoal();
  await post(`${buyerBase()}/api/plan`, { goal });
}

const sha = z.string().regex(/^[0-9a-f]{64}$/);
export const evidenceSchema = z.object({
  task_id: z.string(),
  contract: z.record(z.string(), z.unknown()).nullable(),
  contract_sha256: sha.nullable(),
  /** Delivery files as the worker holds them; sha256 is the directory hash the verdict names. */
  delivery: z
    .object({ files: z.array(z.object({ path: z.string(), content: z.string() })), sha256: sha })
    .nullable(),
  verdict: verdictRecordSchema.nullable(),
  /** Accepted spend intent (needs engine evidence fields `intent` and `intent_sha256`); absent until reported. */
  intent: z.unknown().optional(),
  intent_sha256: sha.nullish(),
});
export type Evidence = z.infer<typeof evidenceSchema>;

export async function fetchEvidence(taskId: string): Promise<Evidence> {
  if (isMock()) return mock.fetchEvidence(taskId);
  let res: Response;
  try {
    res = await fetch(`${engineBase()}/api/tasks/${encodeURIComponent(taskId)}/evidence`);
  } catch {
    throw new ApiError("UNREACHABLE", "The engine could not be reached.");
  }
  // 404 only means the engine has not registered this task yet: not an error, try again on the next event.
  if (res.status === 404)
    return {
      task_id: taskId,
      contract: null,
      contract_sha256: null,
      delivery: null,
      verdict: null,
    };
  if (!res.ok) throw new ApiError("HTTP_ERROR", `The engine answered with status ${res.status}.`);
  const r = evidenceSchema.safeParse(await res.json().catch(() => null));
  if (!r.success)
    throw new ApiError("BAD_RESPONSE", "The engine sent evidence this screen cannot read.");
  const ev = r.data;
  if (ev.delivery || !ev.verdict) return ev;
  // The engine never sees the delivery: ask the worker for the files and let the browser hash them.
  const files = await fetchWorkerDelivery(taskId);
  return files ? { ...ev, delivery: { files, sha256: ev.verdict.delivery_sha256 } } : ev;
}

export const chainSchema = z.object({
  height: z.number(),
  payments: z.array(
    z.object({
      task_id: z.string(),
      payment_hash: z.string(),
      locked_at_height: z.number().nullable(),
      expires_at_height: z.number().nullable(),
    }),
  ),
});
export type Chain = z.infer<typeof chainSchema>;

export async function fetchChain(): Promise<Chain> {
  if (isMock()) return mock.fetchChain();
  const r = chainSchema.safeParse(await getJson(`${engineBase()}/api/chain`));
  if (!r.success)
    throw new ApiError("BAD_RESPONSE", "The engine sent chain data this screen cannot read.");
  return r.data;
}

export const taskListSchema = z.object({
  tasks: z.array(
    z.object({
      task_id: z.string(),
      description: z.string(),
      amount: z.string(),
      root_hash: z.string().nullish(),
    }),
  ),
});
export type TaskList = z.infer<typeof taskListSchema>;

/** Every task the engine has offered, with the description from its signed contract. */
export async function fetchTasks(): Promise<TaskList> {
  if (isMock()) return mock.fetchTasks();
  const r = taskListSchema.safeParse(await getJson(`${engineBase()}/api/tasks`));
  if (!r.success)
    throw new ApiError("BAD_RESPONSE", "The engine sent a task list this screen cannot read.");
  return r.data;
}

/** GET /api/mandates, newest first. Bad rows are skipped (see parseMandates). */
export async function fetchMandates(): Promise<MandateRow[]> {
  if (isMock()) return parseMandates(await mock.fetchMandatesJson());
  return parseMandates(await getJson(`${engineBase()}/api/mandates`));
}

/** Task id -> mandate root hash, from GET /api/tasks. */
export async function fetchTaskRoots(): Promise<Record<string, string>> {
  if (isMock()) return parseTaskRoots(await mock.fetchTasksJson());
  return parseTaskRoots(await getJson(`${engineBase()}/api/tasks`));
}

/** Whether the engine was started with the demo switches (VERDICT_DEMO_TOGGLES=1). Any failure means "not available". */
export async function fetchDemoToggles(): Promise<boolean> {
  if (isMock()) return true;
  try {
    const r = z
      .object({ enabled: z.boolean() })
      .safeParse(await getJson(`${engineBase()}/api/demo/toggles`));
    return r.success && r.data.enabled;
  } catch {
    return false;
  }
}

/** Demo: mines regtest blocks until the selected task's escrow expires and is refunded. Progress arrives on the event stream. */
export async function mineUntilRefund(taskId: string): Promise<void> {
  if (isMock()) return mock.mineUntilRefund(taskId);
  await post(`${engineBase()}/api/demo/mine-until-refund`, { task_id: taskId });
}

const amountString = z.string().regex(/^\d+(\.\d+)?$/);
export const fundsSchema = z.object({
  spendable: amountString,
  reserved: amountString,
  available_to_delegate: amountString,
});
/** Buyer node's tUSD, as decimal strings computed by the engine (the screen does no sums on them). */
export type Funds = z.infer<typeof fundsSchema>;

/** The error body of a failed engine read, when it has one. */
async function failureOf(res: Response, fallback: string): Promise<ApiError> {
  const j = z
    .object({ code: z.string().optional(), message: z.string().optional() })
    .safeParse(await res.json().catch(() => null));
  return new ApiError(
    (j.success && j.data.code) || "HTTP_ERROR",
    (j.success && j.data.message) || fallback,
  );
}

/** GET /api/funds. A wallet-less engine answers 503: the panel shows that, never a made-up balance. */
export async function fetchFunds(): Promise<Funds> {
  if (isMock()) return mock.fetchFunds();
  let res: Response;
  try {
    res = await fetch(`${engineBase()}/api/funds`);
  } catch {
    throw new ApiError("UNREACHABLE", "The engine could not be reached, so the funds are unknown.");
  }
  if (!res.ok) throw await failureOf(res, "The engine could not report the funds.");
  const r = fundsSchema.safeParse(await res.json().catch(() => null));
  if (!r.success)
    throw new ApiError("BAD_RESPONSE", "The engine sent funds this screen cannot read.");
  return r.data;
}

/** GET /api/principal: the engine asks the principal-signer for its public id. 502 when the signer is down. */
export async function fetchPrincipal(): Promise<{ id: string }> {
  if (isMock()) return mock.fetchPrincipal();
  let res: Response;
  try {
    res = await fetch(`${engineBase()}/api/principal`);
  } catch {
    throw new ApiError(
      "UNREACHABLE",
      "The engine could not be reached, so no principal can be connected.",
    );
  }
  if (!res.ok) throw await failureOf(res, "The principal signer did not answer.");
  const r = z.object({ id: z.string().min(1) }).safeParse(await res.json().catch(() => null));
  if (!r.success)
    throw new ApiError("BAD_RESPONSE", "The engine sent a principal id this screen cannot read.");
  return { id: r.data.id };
}

/** Asks the buyer agent to write an acceptance test for a request. Refusals (AUTHOR_FAILED, TASK_NOT_VERIFIABLE) are ApiErrors. */
export async function authorTest(request: string): Promise<Draft> {
  if (isMock()) return mock.authorTest(request);
  const draft = parseAuthorAnswer(await post(`${buyerBase()}/api/author`, { request }));
  if (!draft)
    throw new ApiError("BAD_RESPONSE", "The buyer agent sent a test this screen cannot read.");
  return draft;
}

/** Installs a (possibly edited) draft as a task type on the engine. 422 DRAFT_REJECTED / 503 come back as ApiErrors. */
export async function installTaskType(draft: Draft): Promise<Installed> {
  if (isMock()) return mock.installTaskType(draft);
  const r = installedSchema.safeParse(await post(`${engineBase()}/api/task-types`, { draft }));
  if (!r.success)
    throw new ApiError("BAD_RESPONSE", "The engine sent an answer this screen cannot read.");
  return r.data;
}
