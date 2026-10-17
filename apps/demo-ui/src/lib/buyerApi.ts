import { z } from "zod";

const buyerBase = () => {
  const q = new URLSearchParams(location.search).get("buyer");
  const env = import.meta.env;
  return `${location.protocol}//${q ?? `${env.VITE_ENGINE_HOST ?? location.hostname}:${env.VITE_BUYER_PORT ?? "7402"}`}`;
};

/** One entry of the buyer agent's own event ring (GET /api/events). `data` is parsed per type by the reader. */
export const buyerEventSchema = z.object({
  seq: z.number(),
  at: z.string(),
  type: z.string(),
  data: z.unknown(),
});
export type BuyerEvent = z.infer<typeof buyerEventSchema>;

/** Newest-last list of the buyer's events. Throws when the buyer agent cannot be reached or answers nonsense. */
export async function fetchBuyerEvents(): Promise<BuyerEvent[]> {
  const r = await fetch(`${buyerBase()}/api/events`);
  if (!r.ok) throw new Error("buyer agent not reachable");
  return z.object({ events: z.array(buyerEventSchema) }).parse(await r.json()).events;
}

const optText = z.string().optional();
const decisionData = z
  .object({
    intent_sha256: optText,
    cap_hash: optText,
    intent: z.unknown().optional(),
    decision: z
      .object({ status: z.string(), code: optText, message: optText, task_id: optText })
      .passthrough()
      .optional(),
  })
  .passthrough();
const proposedData = z.object({ goal: optText, thinking: optText }).passthrough();

export interface BuyerFacts {
  /** The goal text given to the mandate proposal (needs buyer field `mandate.proposed.goal`). */
  mandateGoal: string | null;
  /** Model reasoning collected after the call (needs `thinking` on `mandate.proposed` / `intent.proposed`). */
  thinking: string | null;
  /** The buyer's record of the engine's answer to this task's spend intent (needs `intent_sha256` on both sides). */
  decision: { status: string; code: string | null; message: string | null } | null;
  /** Time on the buyer service's own clock for that decision. */
  decisionAt: string | null;
}

/** Joins the buyer ring to a task by `intent_sha256`. Without the hash nothing is guessed: fields stay null. */
export function buyerFacts(events: readonly BuyerEvent[], intentSha: string | null): BuyerFacts {
  const out: BuyerFacts = { mandateGoal: null, thinking: null, decision: null, decisionAt: null };
  for (const e of events) {
    if (e.type === "mandate.proposed") {
      const p = proposedData.safeParse(e.data);
      if (p.success) {
        out.mandateGoal = p.data.goal ?? out.mandateGoal;
        out.thinking = p.data.thinking ?? out.thinking;
      }
    }
    if (e.type === "intent.engine_decision" && intentSha) {
      const d = decisionData.safeParse(e.data);
      if (d.success && d.data.intent_sha256 === intentSha && d.data.decision) {
        out.decision = {
          status: d.data.decision.status,
          code: d.data.decision.code ?? null,
          message: d.data.decision.message ?? null,
        };
        out.decisionAt = e.at;
      }
    }
  }
  return out;
}
