import { randomBytes } from "node:crypto";
import { type LocalOnlyOptions, localOnly, loggerOptions } from "@verdict/http-local";
import {
  amountFlags,
  type HardLimits,
  hardLimits,
  rootLimitViolation,
} from "@verdict/mandate-guard";
import {
  CAP_VERSION,
  capId,
  hashObj,
  type RootCapability,
  rootCapabilitySchema,
  type Signer,
  signPayload,
} from "@verdict/protocol";
import Fastify, { type FastifyInstance } from "fastify";

export const SERVICE = "principal-signer";
export const DEFAULT_PORT = 7403;

const PLACEHOLDER_SIG = `0x${"0".repeat(130)}`;
const PLACEHOLDER_ID = "cap_0000000000000000";
const SUBJECT = "buyer-agent";
const PRECISION = 2;
export const CONFIRM_TTL_MS = 120_000;

export interface SignerDeps {
  /** The only holder of the Principal key. Injected so tests use a fake. */
  readonly signer: Signer;
  /** Public id the engine trusts (identities.json). Signing is refused if the key differs. */
  readonly principalId: string;
  /** tUSD asset id from network.json. */
  readonly assetId: string;
  readonly logger?: boolean;
  /** Hard limits (same source as the engine). Defaults to the MAX_ROOT_* environment. */
  readonly limits?: HardLimits;
  readonly now?: () => Date;
  /** Host/peer/Origin guard. main.ts always passes it; unit tests may omit it. */
  readonly localOnly?: LocalOnlyOptions;
}

/** Builds the unsigned root fields from the buyer's proposal. Returns undefined if unusable. */
function rootFromProposal(p: unknown, principal: string, assetId: string) {
  if (typeof p !== "object" || p === null) return undefined;
  const o = p as Record<string, unknown>;
  if (!Array.isArray(o.allowed_payees)) return undefined;
  const ids = o.allowed_payees.map((x) =>
    typeof x === "string" ? x : (x as { id?: unknown } | null)?.id,
  );
  return {
    version: CAP_VERSION,
    issuer: principal,
    subject: SUBJECT,
    asset_id: assetId,
    max_total: o.max_total,
    max_per_task: o.max_per_task,
    allowed_actions: o.allowed_actions,
    allowed_categories: o.allowed_categories,
    counterparties: "preapproved_workers",
    allowed_payees: ids,
    recurring: false,
    expires_at: o.expires_at,
    parent: null,
  };
}

/**
 * Signs (never registers) a root mandate after the Principal clicked approve in the console.
 * The signer decides for itself whether a mandate is unusual: it recomputes the amount-in-text check from the
 * goal text and applies the hard limits. Client-sent `flagged` / `second_confirm` fields are ignored. A flagged
 * mandate is signed only on a second call carrying a single-use token bound to that exact root.
 * Threat model: a malicious local process that can call this port is out of scope (loopback + UI header only).
 */
export function buildSignerServer(d: SignerDeps): FastifyInstance {
  const app = Fastify({
    logger: d.logger === false ? false : loggerOptions(SERVICE),
  });

  if (d.localOnly) localOnly(app, d.localOnly);
  const now = d.now ?? (() => new Date());
  const limits = d.limits ?? hardLimits();
  /** token -> the root hash it confirms, single use, short TTL. Never taken from the client's say-so. */
  const confirmations = new Map<string, { rootHash: string; expires: number }>();

  app.get("/health", async () => ({ ok: true, service: SERVICE, principal: d.principalId }));

  app.post("/sign-root", async (req, reply) => {
    const refuse = (status: number, code: string, message: string) => {
      reply.code(status);
      return { ok: false as const, code, message };
    };
    if (req.headers["x-verdict-ui"] !== "1")
      return refuse(
        403,
        "UI_ONLY",
        "Only the Verdict console may ask for a mandate to be signed. This request did not come from it.",
      );
    try {
      const body = (typeof req.body === "object" && req.body !== null ? req.body : {}) as Record<
        string,
        unknown
      >;
      const parsed = rootCapabilitySchema.safeParse({
        ...(body.proposal !== undefined
          ? (rootFromProposal(body.proposal, d.principalId, d.assetId) ?? {})
          : typeof body.root === "object" && body.root !== null
            ? body.root
            : {}),
        cap_id: PLACEHOLDER_ID,
        signature: PLACEHOLDER_SIG,
      });
      if (!parsed.success)
        return refuse(
          400,
          "MALFORMED_INTENT",
          "The mandate does not follow the expected format, so it was not signed.",
        );
      const goal = body.goal;
      if (typeof goal !== "string" || goal.trim().length === 0 || goal.length > 1000)
        return refuse(
          400,
          "MALFORMED_INTENT",
          "The request did not include the goal text, so the mandate was not signed.",
        );
      const unsigned = parsed.data;
      if (unsigned.issuer !== d.principalId || unsigned.asset_id !== d.assetId)
        return refuse(
          422,
          "SIGNATURE_INVALID",
          "The mandate names a different issuer or asset than this Principal key controls, so it was not signed.",
        );
      const tooBig = rootLimitViolation(unsigned, limits, PRECISION, now());
      if (tooBig)
        return tooBig.kind === "EXPIRED"
          ? refuse(
              422,
              "CAPABILITY_EXPIRED",
              "The mandate has already expired, so it was not signed.",
            )
          : tooBig.kind === "UNREADABLE"
            ? refuse(
                400,
                "MALFORMED_INTENT",
                "The mandate's amounts or expiry cannot be read, so it was not signed.",
              )
            : refuse(
                422,
                "ROOT_OVER_HARD_LIMIT",
                "The mandate is above this machine's hard limits (amount or duration), so it was not signed.",
              );
      const flags = amountFlags(goal, unsigned, PRECISION);
      const rootHash = hashObj(unsigned);
      if (flags.length > 0) {
        const t = now().getTime();
        for (const [k, v] of confirmations) if (v.expires <= t) confirmations.delete(k);
        const given = typeof body.confirm_token === "string" ? body.confirm_token : "";
        const entry = confirmations.get(given);
        confirmations.delete(given); // single use, whether it matches or not
        if (!entry || entry.expires <= t || entry.rootHash !== rootHash) {
          const token = randomBytes(16).toString("hex");
          confirmations.set(token, { rootHash, expires: t + CONFIRM_TTL_MS });
          reply.code(428);
          return {
            ok: false as const,
            code: "SECOND_CONFIRM_REQUIRED",
            message:
              "This mandate looks unusual: an amount in it does not appear in what you wrote. Please confirm a second time before it is signed.",
            confirm_token: token,
            expires_in_seconds: CONFIRM_TTL_MS / 1000,
            flags: flags.map((f) => ({
              code: f.code,
              message: `The mandate allows ${f.amount} tUSD but your text never mentions that amount.`,
            })),
          };
        }
      }
      if (d.signer.publicId !== d.principalId)
        return refuse(
          500,
          "SIGNATURE_INVALID",
          "The Principal key on this machine does not match the trusted identity, so nothing was signed.",
        );
      const withId = { ...unsigned, cap_id: capId({ ...unsigned, cap_id: PLACEHOLDER_ID }) };
      const root: RootCapability = {
        ...withId,
        signature: await signPayload(d.signer, "CAP_ROOT", withId),
      };
      return { ok: true as const, root };
    } catch {
      return refuse(
        500,
        "MALFORMED_INTENT",
        "The mandate could not be signed. Nothing was signed.",
      );
    }
  });
  return app;
}
