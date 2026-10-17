import {
  contractHash,
  hashObj,
  type TaskContract,
  taskContractSchema,
  verdictRecordSchema,
} from "@verdict/protocol";
import type { FastifyInstance } from "fastify";
import type { Ledger } from "../ledger/index.js";

export interface EvidenceDeps {
  readonly ledger: Ledger;
  /** Current block height. Absent or failing: /api/chain answers 503. */
  readonly height?: () => Promise<number>;
}

/**
 * Read-only audit routes for the UI. Nothing here ever includes the preimage or the sealed preimage.
 * Delivery: the engine never receives the worker's bundle (it goes worker -> verifier), so `delivery` is null
 * until a delivery is recorded. When present, `sha256` is sha256 of the UTF-8 bytes of `text`.
 */
/** The two fields the task list shows, read defensively from the stored offer. */
function offerView(c: unknown): { description: string; amount: string } | null {
  const o = c as { task?: { spec?: unknown }; payment?: { amount?: unknown } } | null;
  const description = o?.task?.spec;
  const amount = o?.payment?.amount;
  return typeof description === "string" && typeof amount === "string"
    ? { description, amount }
    : null;
}

export function registerEvidenceRoutes(app: FastifyInstance, d: EvidenceDeps): void {
  // Every task the engine offered, with the description from its signed contract (the task spec) and the price.
  app.get("/api/tasks", async () => ({
    tasks: d.ledger.listOffers().flatMap((o) => {
      const v = offerView(o.contract);
      return v ? [{ task_id: o.taskId, ...v }] : [];
    }),
  }));

  app.get("/api/tasks/:task_id/evidence", async (req, reply) => {
    const id = (req.params as { task_id: string }).task_id;
    const stored = d.ledger.getContractByTask(id);
    if (!stored) {
      reply.code(404);
      return { ok: false, message: "This task is not known to the engine." };
    }
    const c = taskContractSchema.safeParse(stored.contract);
    const contract: TaskContract | null = c.success ? c.data : null;
    const verdicts = d.ledger
      .verdictsFor(stored.paymentHash)
      .map((v) => verdictRecordSchema.safeParse(v))
      .flatMap((p) => (p.success ? [p.data] : []));
    // The accepted spend intent of this task (never the preimage); null when unknown.
    const intentSha = d.ledger.intentShaForTask(id) ?? null;
    const accepted = intentSha ? d.ledger.getAcceptedIntent(intentSha) : undefined;
    return {
      task_id: id,
      intent: accepted ? accepted.intent : null,
      intent_sha256: accepted ? intentSha : null,
      contract,
      contract_sha256: contract
        ? contractHash(contract as unknown as Record<string, unknown>)
        : hashObj(null),
      delivery: null,
      verdict: verdicts.length > 0 ? verdicts[verdicts.length - 1] : null,
    };
  });

  app.get("/api/chain", async (_req, reply) => {
    let height: number;
    try {
      if (!d.height) throw new Error("no chain source");
      height = await d.height();
    } catch {
      reply.code(503);
      return { ok: false, message: "The block height is not available right now." };
    }
    return {
      height,
      payments: d.ledger.listPayments().map((p) => ({
        task_id: p.taskId,
        payment_hash: p.paymentHash,
        locked_at_height: p.lockedHeight,
        expires_at_height:
          p.lockedHeight !== null && p.cltvBlocks !== null ? p.lockedHeight + p.cltvBlocks : null,
      })),
    };
  });
}
