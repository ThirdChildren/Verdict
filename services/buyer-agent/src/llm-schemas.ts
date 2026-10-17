import { amountsInText } from "@verdict/mandate-guard";
import { formatAmount, renderBlockMessage, type SpendIntent } from "@verdict/protocol";
import { z } from "zod";
import type { WorkerDirectory } from "./identities.js";

/** Name the model gave a worker ("worker"). Mapped to a public id by code only (resolveWorker). */
const workerName = z.string().min(1).max(100);

/** tUSD uses 2 decimals (ADR-019). */
export const TUSD_PRECISION = 2;

/** LLM-facing schema: no regex, integer minor units. Converted to protocol shapes in code only. */
export const llmIntentSchema = z
  .object({
    kind: z.literal("task_payment"),
    worker: workerName,
    category: z.enum(["code", "data", "writing", "research", "other"]),
    amount_minor: z.number().int().min(1).max(100000),
    recurring: z.boolean(),
    interval: z.enum(["none", "weekly", "monthly"]),
    task_spec: z.string().min(1).max(300),
    deadline_minutes: z.number().int().min(5).max(1440),
    rationale: z.string().min(1).max(200),
  })
  .strict()
  .refine(
    (i) => i.recurring === (i.interval !== "none"),
    "recurring must be true exactly when interval is not none",
  );
export type LlmIntent = z.infer<typeof llmIntentSchema>;

export const llmMandateSchema = z
  .object({
    worker: workerName,
    max_total_minor: z.number().int().min(1).max(10000000),
    max_per_task_minor: z.number().int().min(1).max(10000000),
    category: z.enum(["code", "data", "writing", "research", "other"]),
    expires_minutes: z.number().int().min(5).max(10080),
    summary: z.string().min(1).max(600),
  })
  .strict()
  .refine(
    (m) => m.max_per_task_minor <= m.max_total_minor,
    "max_per_task must not exceed max_total",
  );
export type LlmMandate = z.infer<typeof llmMandateSchema>;

/** Unsigned proposal the UI shows; the engine signs it after the Principal clicks "Sign mandate". */
export type MandateProposal = {
  max_total: string;
  max_per_task: string;
  allowed_actions: ["task_payment"];
  allowed_categories: [string];
  /** Payee allowlist: the preconfigured worker. */
  counterparties: [string];
  recurring: false;
  expires_at: string;
  summary: string;
  /** Payees the mandate allows, with the names the UI shows. */
  allowed_payees: { name: string; id: string }[];
  flags: ProposalFlag[];
  /** True when any flag is raised: the UI must ask the Principal to confirm twice. */
  needs_second_confirm: boolean;
};

export type ProposalFlag = { code: "AMOUNT_NOT_IN_GOAL"; message: string };

export function isoIn(minutes: number, now: Date): string {
  return new Date(now.getTime() + minutes * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Deterministic name lookup. Unknown name -> COUNTERPARTY_NOT_ALLOWED, nothing is sent. */
export function resolveWorker(name: string, workers: WorkerDirectory): string {
  const id = Object.hasOwn(workers, name.trim().toLowerCase())
    ? workers[name.trim().toLowerCase()]
    : undefined;
  if (!id) {
    throw new CounterpartyError(
      renderBlockMessage("COUNTERPARTY_NOT_ALLOWED", { counterparty: `"${name}"` }).replace(
        "Nothing was signed and no funds moved.",
        "Nothing was sent and no funds moved.",
      ),
    );
  }
  return id;
}

export class CounterpartyError extends Error {
  readonly code = "COUNTERPARTY_NOT_ALLOWED" as const;
  constructor(message: string) {
    super(message);
    this.name = "CounterpartyError";
  }
}

export function toMandateProposal(
  m: LlmMandate,
  now: Date,
  worker: string,
  goal: string,
  workers: WorkerDirectory,
): MandateProposal {
  const seen = amountsInText(goal);
  const flags: ProposalFlag[] = [];
  for (const minor of new Set([m.max_total_minor, m.max_per_task_minor])) {
    if (!seen.has(BigInt(minor))) {
      flags.push({
        code: "AMOUNT_NOT_IN_GOAL",
        message: `The model suggested ${formatAmount(BigInt(minor), TUSD_PRECISION)} tUSD but your text never mentions that amount.`,
      });
    }
  }
  const name = Object.keys(workers).find((k) => workers[k] === worker) ?? "worker";
  return {
    max_total: formatAmount(BigInt(m.max_total_minor), TUSD_PRECISION),
    max_per_task: formatAmount(BigInt(m.max_per_task_minor), TUSD_PRECISION),
    allowed_actions: ["task_payment"],
    allowed_categories: [m.category],
    counterparties: [worker],
    recurring: false,
    expires_at: isoIn(m.expires_minutes, now),
    summary: m.summary,
    allowed_payees: [{ name, id: worker }],
    flags,
    needs_second_confirm: flags.length > 0,
  };
}

export function toSpendIntent(i: LlmIntent, counterparty: string, now: Date): SpendIntent {
  return {
    kind: i.kind,
    category: i.category,
    counterparty,
    amount: formatAmount(BigInt(i.amount_minor), TUSD_PRECISION),
    recurring: i.recurring,
    interval: i.recurring ? i.interval : null,
    task_spec: i.task_spec,
    deadline: isoIn(i.deadline_minutes, now),
    rationale: i.rationale,
  };
}

export { amountsInText };
