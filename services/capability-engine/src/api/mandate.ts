import { rateLimit } from "@verdict/http-local";
import { rootLimitViolation } from "@verdict/mandate-guard";
import {
  type ChildCapability,
  capabilityHash,
  capId,
  childCapabilitySchema,
  cmpAmount,
  formatAmount,
  hashObj,
  parseAmount,
  type RefusalResponse,
  type RootCapability,
  rootCapabilitySchema,
  type Signer,
  signPayload,
  verifyPayload,
} from "@verdict/protocol";
import type { FastifyInstance } from "fastify";
import type { HardLimits } from "../config.js";
import type { EventBus } from "../events.js";
import type { Ledger } from "../ledger/index.js";
import { type Block, block, canDerive, withDetail } from "../policy/index.js";

export interface EngineIdentities {
  readonly principal: string;
  readonly engine: string;
  readonly buyer: string;
  /** The verifier's id; its P_CONFIRM and VERDICT messages are the only ones the engine takes from it. */
  readonly verifier?: string;
}

export interface MandateDeps {
  readonly ledger: Ledger;
  readonly identities: EngineIdentities;
  readonly engineSigner: Signer;
  readonly limits: HardLimits;
  readonly precision: number;
  readonly now: () => Date;
  readonly bus: EventBus;
  /** tUSD asset id from network.json. When set, a root for any other asset is refused. */
  readonly assetId?: string;
  /** Default 10 requests per minute: the console never needs more. */
  readonly rateLimit?: { max: number; windowMs: number };
  /** Lifetime of a per-task child from POST /api/mandate/task (default 1 hour, capped by the root's expiry). */
  readonly taskTtlMs?: number;
}

const PLACEHOLDER_SIG = `0x${"0".repeat(130)}`;

/**
 * UI-layer code for a root above the engine's hard limits. It is not in the protocol block catalogue,
 * so it is only ever returned by /api/mandate, never inside a REFUSAL or a BLOCKED event.
 */
export const ROOT_OVER_HARD_LIMIT = "ROOT_OVER_HARD_LIMIT";

type LimitBlock = Block & { readonly hardLimit?: true };
const hard = (b: Block): LimitBlock => ({ ...b, hardLimit: true });

/**
 * Pure check of the hard limits and the issuer on a Zod-parsed root (the signature is checked
 * separately because it is async). Returns the BLOCK to show, or undefined.
 */
const max0 = (n: bigint): bigint => (n < 0n ? 0n : n);

export function checkRootLimits(
  root: { issuer: string; max_total: string; max_per_task: string; expires_at: string },
  principal: string,
  limits: HardLimits,
  precision: number,
  now: Date,
): LimitBlock | undefined {
  if (root.issuer !== principal)
    return block("SIGNATURE_INVALID", {
      subject: "the mandate (it was not issued by the Principal key this engine trusts)",
    });
  const v = rootLimitViolation(root, limits, precision, now);
  if (!v) return undefined;
  switch (v.kind) {
    case "TOTAL_OVER_LIMIT":
      return hard(
        withDetail(
          block("AMOUNT_EXCEEDS_PER_TASK", { amount: v.amount, max: v.max }),
          `(The mandate's total of ${v.amount} tUSD is above the engine's hard limit of ${v.max} tUSD.)`,
        ),
      );
    case "PER_TASK_OVER_LIMIT":
      return hard(
        withDetail(
          block("AMOUNT_EXCEEDS_PER_TASK", { amount: v.amount, max: v.max }),
          `(The per-task limit is above the engine's hard limit of ${v.max} tUSD.)`,
        ),
      );
    case "EXPIRED":
      return block("CAPABILITY_EXPIRED", { expires_at: v.expires_at });
    case "EXPIRY_TOO_FAR":
      return hard(
        withDetail(
          block("CHILD_OUTLIVES_PARENT", {
            child_expires_at: v.expires_at,
            parent_expires_at: v.latest,
          }),
          `(The engine's hard limit is ${v.seconds} seconds from now.)`,
        ),
      );
    case "UNREADABLE":
      return block("MALFORMED_INTENT", {
        reason: "the mandate's amounts or expiry cannot be read",
      });
  }
}

/** Max milliseconds a per-task child lives unless the root ends sooner. */

export function registerMandateRoutes(app: FastifyInstance, d: MandateDeps): void {
  const refuse = (b: Block, input: unknown): RefusalResponse => {
    d.bus.publish(
      { type: "BLOCKED", data: { code: b.code, message: b.message, intent: input, cap_id: null } },
      d.now(),
    );
    return { ok: false, code: b.code, message: b.message, intent_sha256: hashObj(input ?? null) };
  };

  const buildChild = async (
    root: RootCapability,
    rootHash: string,
    expiresAt: string,
    maxTotal: string = root.max_per_task,
  ): Promise<ChildCapability> => {
    const unsigned: ChildCapability = {
      version: root.version,
      cap_id: "cap_0000000000000000",
      parent: rootHash,
      issuer: d.identities.engine,
      subject: root.subject,
      asset_id: root.asset_id,
      max_total: maxTotal,
      allowed_actions: root.allowed_actions,
      allowed_categories: root.allowed_categories,
      counterparties: root.allowed_payees,
      allowed_payees: root.allowed_payees,
      max_payments: 1,
      recurring: false,
      expires_at: expiresAt,
      signature: PLACEHOLDER_SIG,
    };
    const withId = { ...unsigned, cap_id: capId(unsigned) };
    return { ...withId, signature: await signPayload(d.engineSigner, "CAP_CHILD", withId) };
  };

  /** The UI budget bar shows the root across tasks, so the root and the child are both announced. */
  const announceBudget = (rootHash: string, childHash: string, at: Date): void => {
    for (const h of [rootHash, childHash]) {
      const u = d.ledger.budget(h);
      if (!u) continue;
      d.bus.publish(
        {
          type: "BUDGET_UPDATED",
          data: {
            cap_id: u.capId,
            remaining: formatAmount(max0(u.remaining), d.precision),
            reserved: formatAmount(u.reserved, d.precision),
            committed: formatAmount(u.committed, d.precision),
          },
        },
        at,
      );
    }
  };

  const limiter = rateLimit(d.rateLimit ?? { max: 10, windowMs: 60_000 });
  app.post("/api/mandate", { preHandler: limiter }, async (req, reply) => {
    const body: unknown = req.body;
    const fail = (status: number, b: Block) => {
      reply.code(status);
      return refuse(b, body);
    };
    try {
      const inner =
        typeof body === "object" && body !== null ? (body as Record<string, unknown>).root : null;
      const parsed = rootCapabilitySchema.safeParse(inner);
      if (!parsed.success)
        return fail(
          400,
          block("MALFORMED_INTENT", { reason: "the mandate does not follow the protocol format" }),
        );
      const root = parsed.data;
      const now = d.now();
      if (root.cap_id !== capId(root))
        return fail(
          400,
          block("MALFORMED_INTENT", { reason: "the mandate id does not match its content" }),
        );
      const limit = checkRootLimits(root, d.identities.principal, d.limits, d.precision, now);
      if (limit?.hardLimit) {
        // Local UI code: no BLOCKED event and no protocol REFUSAL shape, so the catalogue stays closed.
        reply.code(422);
        return { ok: false, code: ROOT_OVER_HARD_LIMIT, message: limit.message };
      }
      if (limit) return fail(422, limit);
      if (d.assetId !== undefined && root.asset_id !== d.assetId)
        return fail(422, block("ASSET_MISMATCH", { actual: root.asset_id, expected: d.assetId }));
      if (!(await verifyPayload("CAP_ROOT", root, root.issuer, root.signature)))
        return fail(401, block("SIGNATURE_INVALID", { subject: "the mandate" }));

      const rootHash = capabilityHash(root);
      if (d.engineSigner.publicId !== d.identities.engine)
        return fail(500, block("SIGNATURE_INVALID", { subject: "the engine's own signing key" }));
      const child = await buildChild(root, rootHash, root.expires_at);
      const rootKnown = d.ledger.getCapability(rootHash) !== undefined;
      const dec = canDerive(root, child, {
        now,
        precision: d.precision,
        parentSignatureValid: true,
        parentRevoked: rootKnown && d.ledger.isRevoked(rootHash),
        parentHash: rootHash,
        parentRemaining: rootKnown
          ? d.ledger.remaining(rootHash)
          : parseAmount(root.max_total, d.precision),
        preapprovedWorkers: root.allowed_payees,
      });
      if (!dec.ok) return fail(422, dec);

      const childHash = capabilityHash(child);
      d.ledger.registerCapability(root, rootHash);
      d.ledger.registerCapability(child, childHash, rootHash, d.identities.buyer);
      d.bus.publish({ type: "CAP_ROOT", data: root }, now);
      d.bus.publish({ type: "CAP_CHILD", data: child }, now);
      announceBudget(rootHash, childHash, now);
      return { ok: true, root_cap_id: root.cap_id, cap_hash: childHash };
    } catch {
      // Fail closed: nothing is registered unless every step above completed.
      return fail(500, block("MALFORMED_INTENT", { reason: "the mandate could not be processed" }));
    }
  });

  const taskLimiter = rateLimit(d.rateLimit ?? { max: 10, windowMs: 60_000 });
  /**
   * A new per-task child under the already-registered root: no new Principal signature (the root is the
   * Principal's signed mandate). Each child gets a task-scoped expiry so its hash is distinct.
   */
  app.post("/api/mandate/task", { preHandler: taskLimiter }, async (req, reply) => {
    const body: unknown = req.body;
    const fail = (status: number, b: Block) => {
      reply.code(status);
      // Hash the request body (task amount included) so two refusals are never mistaken for one another.
      return refuse(b, body ?? null);
    };
    try {
      const rootHash = d.ledger.latestRoot();
      const parsed = rootCapabilitySchema.safeParse(
        rootHash ? d.ledger.getCapability(rootHash) : undefined,
      );
      if (!rootHash || !parsed.success)
        return fail(
          409,
          block("MALFORMED_INTENT", {
            reason:
              "no mandate has been signed yet, so there is nothing to derive a task permission from",
          }),
        );
      const root = parsed.data;
      if (d.engineSigner.publicId !== d.identities.engine)
        return fail(500, block("SIGNATURE_INVALID", { subject: "the engine's own signing key" }));
      const now = d.now();
      const rootValid = await verifyPayload("CAP_ROOT", root, root.issuer, root.signature);
      // The task permission is capped by the task's own amount (body.amount) or else by what the mandate has left,
      // never by the mandate's per-task ceiling alone: that ceiling can exceed the remaining budget.
      const left = d.ledger.remaining(rootHash);
      const perTask = parseAmount(root.max_per_task, d.precision);
      const rawAmount =
        typeof body === "object" && body !== null
          ? (body as Record<string, unknown>).amount
          : undefined;
      let childMax: bigint;
      if (rawAmount === undefined) childMax = left < perTask ? left : perTask;
      else {
        try {
          childMax = parseAmount(String(rawAmount), d.precision);
        } catch {
          return fail(
            422,
            block("MALFORMED_INTENT", { reason: "the task amount is not a valid amount" }),
          );
        }
      }
      if (childMax <= 0n)
        return fail(
          422,
          block("AMOUNT_EXCEEDS_REMAINING", {
            amount: formatAmount(max0(childMax), d.precision),
            remaining: formatAmount(max0(left), d.precision),
          }),
        );
      const maxTotal = formatAmount(childMax, d.precision);
      // Default: the task permission lasts as long as the mandate (a shorter default made tasks with a later deadline fail).
      let ms = Math.min(
        Date.parse(root.expires_at),
        d.taskTtlMs === undefined ? Number.POSITIVE_INFINITY : now.getTime() + d.taskTtlMs,
      );
      if (!Number.isFinite(ms))
        return fail(
          422,
          block("MALFORMED_INTENT", { reason: "the mandate's expiry cannot be read" }),
        );
      // Distinct hash per task: the expiry steps down 1 ms until the child is new (always a valid narrowing).
      let child = await buildChild(root, rootHash, new Date(ms).toISOString(), maxTotal);
      for (let i = 0; d.ledger.getCapability(capabilityHash(child)) !== undefined; i++) {
        if (i >= 5000) throw new Error("no free task permission slot");
        ms -= 1;
        child = await buildChild(root, rootHash, new Date(ms).toISOString(), maxTotal);
      }
      const dec = canDerive(root, child, {
        now,
        precision: d.precision,
        parentSignatureValid: rootValid,
        parentRevoked: d.ledger.isRevoked(rootHash),
        parentHash: rootHash,
        parentRemaining: d.ledger.remaining(rootHash),
        preapprovedWorkers: root.allowed_payees,
      });
      if (!dec.ok) return fail(422, dec);
      const childHash = capabilityHash(child);
      d.ledger.registerCapability(child, childHash, rootHash, d.identities.buyer);
      d.bus.publish({ type: "CAP_CHILD", data: child }, now);
      announceBudget(rootHash, childHash, now);
      return { ok: true, cap_hash: childHash };
    } catch {
      return fail(
        500,
        block("MALFORMED_INTENT", { reason: "the task permission could not be created" }),
      );
    }
  });

  app.get("/api/mandate/active", async (_req, reply) => {
    const h = d.ledger.latestChild();
    if (!h) {
      reply.code(404);
      return { ok: false, message: "No mandate has been signed yet." };
    }
    const cap = childCapabilitySchema.safeParse(d.ledger.getCapability(h));
    if (!cap.success) return { cap_hash: h };
    return {
      cap_hash: h,
      allowed_categories: cap.data.allowed_categories,
      expires_at: cap.data.expires_at,
      remaining: formatAmount(max0(d.ledger.remaining(h)), d.precision),
    };
  });
}
