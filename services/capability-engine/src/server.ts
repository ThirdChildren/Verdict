import websocket from "@fastify/websocket";
import {
  defaultUiOrigins,
  type LocalOnlyOptions,
  lanServerOptions,
  listenHost,
  localOnly,
  loggerOptions,
} from "@verdict/http-local";
import {
  type Acceptance,
  capabilityHash,
  capabilitySchema,
  childCapabilitySchema,
  envelopeSchema,
  formatAmount,
  hashObj,
  isFresh,
  type RefusalResponse,
  type Signer,
  verifyPayload,
} from "@verdict/protocol";
import type { WalletPort } from "@verdict/wallet";
import Fastify, { type FastifyInstance } from "fastify";
import { type DemoRouteDeps, registerDemoToggleRoutes } from "./api/demo.js";
import { registerEvidenceRoutes } from "./api/evidence.js";
import { registerFundsRoutes } from "./api/funds.js";
import { type EngineIdentities, registerMandateRoutes } from "./api/mandate.js";
import type { Catalogue } from "./catalogue.js";
import { type HardLimits, hardLimits } from "./config.js";
import { Escrow } from "./escrow.js";
import { type EngineEvent, EventBus } from "./events.js";
import type { Ledger } from "./ledger/index.js";
import { type OfferConfig, OfferService } from "./offer.js";
import { type Block, block, checkIntent } from "./policy/index.js";
import { TaskTracker } from "./tasks.js";
import { VerifierLink } from "./verifier-link.js";

export const SERVICE = "capability-engine";
export const DEFAULT_PORT = 7401;

export interface ServerOptions {
  logger?: boolean;
  ledger?: Ledger;
  precision?: number;
  now?: () => Date;
  /** Silence after the lock before the UI hears WORKER_STATUS "stopped" (env VERDICT_WORKER_SILENCE_MS, default 20 s). */
  workerSilenceMs?: number;
  preapprovedWorkers?: readonly string[];
  bus?: EventBus;
  /** Public ids of principal, engine and buyer (identities.json). Required for /api/mandate. */
  identities?: EngineIdentities;
  /** Signs child capabilities as the engine. Injected so tests use fakes. */
  engineSigner?: Signer;
  limits?: HardLimits;
  /** tUSD asset id from network.json; roots for any other asset are refused. */
  assetId?: string;
  /** Host/peer/Origin guard. main.ts always passes it; tests that call inject() without a Host header omit it. */
  localOnly?: LocalOnlyOptions;
  /** The buyer's wallet daemon. Without it the engine accepts mandates and intents but cannot pay (TASK_ACCEPT/HODL_INVOICE answer 501). */
  wallet?: WalletPort;
  /** Builds the TASK_OFFER for every accepted intent. Without it the engine only accepts intents (P3.1 behaviour). */
  offer?: Omit<OfferConfig, "ledger" | "bus" | "engineSigner" | "now" | "assetId">;
  /** Test seam: the fetch used for P_DEPOSIT to the verifier. */
  verifierFetch?: typeof fetch;
  /** Requests per window allowed on /api/mandate (default 10 per minute). */
  mandateRateLimit?: { max: number; windowMs: number };
  /** Base URL of the principal-signer for GET /api/principal (default http://127.0.0.1:$PRINCIPAL_SIGNER_PORT or 7403). */
  signerUrl?: string;
  /** Test seam: the fetch used to ask the principal-signer for its identity. */
  signerFetch?: typeof fetch;
  /** Block height source for /api/chain and lock heights (bitcoind in main.ts; a stub in tests). */
  chainHeight?: () => Promise<number>;
  /** Lifetime of a per-task child capability (default 1 hour). */
  taskTtlMs?: number;
  /** Verifiable task types (verifier-packages/*). Enables GET /api/task-types and the refusal in POST /api/mandate/task. */
  catalogue?: Catalogue;
  /** Demo console: the "mine until refund" route exists only when `enabled` (VERDICT_DEMO_TOGGLES=1). */
  demo?: { enabled: boolean; mine: DemoRouteDeps["mine"]; pauseMs?: number };
}

/** Messages the verifier (Mac) may POST over the LAN; everything else stays on loopback. */
export const LAN_ROUTES = ["POST /v0/messages"] as const;

export function engineConfig(env: NodeJS.ProcessEnv = process.env): {
  port: number;
  host: string;
  localOnly: LocalOnlyOptions;
} {
  const port = Number(env.ENGINE_PORT ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid ENGINE_PORT");
  const lanBind = env.VERDICT_LAN_BIND;
  const lo: LocalOnlyOptions = {
    port,
    uiOrigins: defaultUiOrigins(env),
    ...(lanBind ? { lanBind, lanRoutes: LAN_ROUTES } : {}),
  };
  return { port, host: listenHost(lo), localOnly: lo };
}

export async function buildServer(opts: ServerOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger === false ? false : loggerOptions(SERVICE),
    ...lanServerOptions(256 * 1024),
  });
  const now = opts.now ?? (() => new Date());
  const bus = opts.bus ?? new EventBus();
  const precision = opts.precision ?? 2;
  if (opts.localOnly) localOnly(app, opts.localOnly);
  await app.register(websocket);

  if (opts.ledger && opts.identities && opts.engineSigner)
    registerMandateRoutes(app, {
      ledger: opts.ledger,
      identities: opts.identities,
      engineSigner: opts.engineSigner,
      limits: opts.limits ?? hardLimits(),
      precision,
      now,
      bus,
      ...(opts.mandateRateLimit ? { rateLimit: opts.mandateRateLimit } : {}),
      ...(opts.assetId ? { assetId: opts.assetId } : {}),
      ...(opts.taskTtlMs ? { taskTtlMs: opts.taskTtlMs } : {}),
      ...(opts.catalogue ? { catalogue: opts.catalogue } : {}),
    });
  const cat = opts.catalogue;
  if (cat) app.get("/api/task-types", async () => ({ ok: true, types: cat.view() }));
  if (opts.ledger)
    registerEvidenceRoutes(app, {
      ledger: opts.ledger,
      precision,
      now,
      ...(opts.chainHeight ? { height: opts.chainHeight } : {}),
    });

  registerFundsRoutes(app, {
    ...(opts.ledger ? { ledger: opts.ledger } : {}),
    ...(opts.wallet ? { wallet: opts.wallet } : {}),
    ...(opts.assetId ? { assetId: opts.assetId } : {}),
    precision,
    ...(opts.identities ? { principalId: opts.identities.principal } : {}),
    signerUrl: opts.signerUrl ?? `http://127.0.0.1:${process.env.PRINCIPAL_SIGNER_PORT ?? "7403"}`,
    ...(opts.signerFetch ? { signerFetch: opts.signerFetch } : {}),
  });

  registerDemoToggleRoutes(app, {
    enabled: opts.demo?.enabled === true && !!opts.ledger && !!opts.wallet && !!opts.chainHeight,
    ledger: opts.ledger as Ledger,
    bus,
    now,
    wallet: opts.wallet as WalletPort,
    mine: opts.demo?.mine ?? (() => undefined),
    chainHeight: opts.chainHeight ?? (async () => 0),
    ...(opts.demo?.pauseMs !== undefined ? { pauseMs: opts.demo.pauseMs } : {}),
  });

  app.get("/health", async () => ({ ok: true, service: SERVICE }));

  opts.ledger?.onBudgetUpdate((u) =>
    bus.publish(
      {
        type: "BUDGET_UPDATED",
        data: {
          cap_id: u.capId,
          remaining: formatAmount(u.remaining, precision),
          reserved: formatAmount(u.reserved, precision),
          committed: formatAmount(u.committed, precision),
        },
      },
      now(),
    ),
  );

  const refuse = (
    d: Block,
    capId: string | null,
    intent: unknown,
    intentSha?: string,
  ): RefusalResponse => {
    bus.publish(
      { type: "BLOCKED", data: { code: d.code, message: d.message, intent, cap_id: capId } },
      now(),
    );
    return {
      ok: false,
      code: d.code,
      message: d.message,
      // The stored form hashObj({cap_hash, intent}) when known, so refusal and acceptance of one intent share a hash.
      intent_sha256: intentSha ?? hashObj(intent ?? null),
    };
  };

  const tasks = new TaskTracker(
    bus,
    now,
    opts.workerSilenceMs ?? (Number(process.env.VERDICT_WORKER_SILENCE_MS) || undefined),
  );
  const escrow =
    opts.ledger && opts.wallet && opts.identities
      ? new Escrow({
          tasks,
          ...(opts.identities.verifier ? { verifierId: opts.identities.verifier } : {}),
          ...(opts.offer && opts.engineSigner
            ? {
                verifier: new VerifierLink({
                  signer: opts.engineSigner,
                  now,
                  ...(opts.verifierFetch ? { fetchImpl: opts.verifierFetch } : {}),
                }),
              }
            : {}),
          ledger: opts.ledger,
          wallet: opts.wallet,
          ...(opts.chainHeight ? { height: opts.chainHeight } : {}),
          bus,
          engineId: opts.identities.engine,
          precision,
          now,
          preapprovedWorkers: opts.preapprovedWorkers ?? [],
        })
      : undefined;
  const offers =
    opts.ledger && opts.offer && opts.engineSigner && opts.assetId
      ? new OfferService({
          ...opts.offer,
          ...(opts.catalogue ? { catalogue: opts.catalogue } : {}),
          ledger: opts.ledger,
          bus,
          engineSigner: opts.engineSigner,
          assetId: opts.assetId,
          now,
        })
      : undefined;
  const stopEscrow = escrow?.start();
  app.addHook("onClose", async () => stopEscrow?.());

  app.post("/v0/messages", async (req, reply) => {
    const body: unknown = req.body;
    // Only signed envelopes are accepted. The legacy unsigned SPEND_INTENT body fails here.
    const env = envelopeSchema.safeParse(body);
    if (!env.success) {
      reply.code(400);
      const raw =
        typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
      return refuse(
        block("MALFORMED_INTENT", { reason: "the message does not follow the protocol format" }),
        null,
        raw.intent ?? body,
      );
    }
    const e = env.data;
    const echo = e.type === "SPEND_INTENT" ? e.body.intent : e.body;
    if (!isFresh(e.sent_at, now().getTime())) {
      reply.code(400);
      return refuse(
        block("MALFORMED_INTENT", { reason: "the message is too old or from the future" }),
        null,
        echo,
      );
    }
    if (!(await verifyPayload(e.type, e as unknown as Record<string, unknown>, e.from, e.sig))) {
      reply.code(401);
      return refuse(block("SIGNATURE_INVALID", { subject: `the ${e.type} message` }), null, echo);
    }
    if (e.type === "SPEND_INTENT") {
      const { cap_hash, intent } = e.body;
      const ledger = opts.ledger;
      // The same signed intent twice gets the first answer back and never a second reservation.
      const intentSha = hashObj({ cap_hash, intent });
      const seen = ledger?.intentResult(intentSha);
      if (seen) {
        reply.code(seen.status);
        return seen.body;
      }
      const remember = <T>(status: number, body: T): T => {
        ledger?.rememberIntentResult(intentSha, { status, body }, now());
        return body;
      };
      const raw = ledger?.getCapability(cap_hash);
      const parsed = childCapabilitySchema.safeParse(raw);
      if (!ledger || !parsed.success) {
        reply.code(422);
        return refuse(block("PARENT_MISMATCH"), null, intent, intentSha);
      }
      const cap = parsed.data;
      if (capabilityHash(cap) !== cap_hash) {
        reply.code(422);
        return refuse(block("PARENT_MISMATCH"), cap.cap_id, intent, intentSha);
      }
      // The signer must be the bound holder of this child capability, before any policy runs.
      const holder = ledger.holderOf(cap_hash);
      if (holder === undefined || holder !== e.from) {
        reply.code(403);
        return refuse(
          block("SIGNATURE_INVALID", {
            subject: "the spend intent (it was not signed by the holder of this task permission)",
          }),
          cap.cap_id,
          intent,
          intentSha,
        );
      }
      // Every ancestor's signed payee list applies, whoever sent the intent.
      let ancestorPayees: string[][];
      try {
        ancestorPayees = ledger.ancestors(cap_hash).map((a) => {
          const q = capabilitySchema.safeParse(a);
          if (!q.success) throw new Error("unreadable ancestor");
          return [...q.data.allowed_payees];
        });
      } catch {
        reply.code(422);
        return refuse(block("PARENT_MISMATCH"), cap.cap_id, intent, intentSha);
      }
      const d = checkIntent(cap, intent, {
        ancestorPayees,
        now: now(),
        precision,
        revoked: ledger.isRevoked(cap_hash),
        remaining: ledger.remaining(cap_hash),
        paymentsMade: ledger.paymentsMade(cap_hash),
        preapprovedWorkers: opts.preapprovedWorkers ?? [],
      });
      if (!d.ok) {
        reply.code(422);
        return remember(422, refuse(d, cap.cap_id, intent, intentSha));
      }
      ledger.recordAcceptedIntent(intentSha, cap_hash, intent, e.from, now());
      if (offers)
        // After the answer: the offer round trip must not hold up the agent, and a failure is shown, never paid.
        setImmediate(() => {
          offers
            .offerFor(intentSha)
            .then((r) => {
              if (!r.ok) refuse(r, cap.cap_id, intent, intentSha);
            })
            .catch((err: unknown) =>
              refuse(
                block("MALFORMED_INTENT", {
                  reason: err instanceof Error ? err.message : "the offer could not be built",
                }),
                cap.cap_id,
                intent,
                intentSha,
              ),
            );
        });
      return remember(200, { ok: true, cap_id: cap.cap_id } satisfies Acceptance);
    }
    if ((e.type === "TASK_ACCEPT" || e.type === "HODL_INVOICE") && escrow) {
      if (e.type === "TASK_ACCEPT") {
        const r = await escrow.acceptContract(e.body, e.from);
        if (!r.ok) {
          reply.code(422);
          return refuse(r, null, echo);
        }
        return { ok: true, task_id: r.taskId };
      }
      const r = await escrow.authorizePayment(e.body.bolt11, e.body.payment_hash, e.from);
      if (!r.ok) {
        reply.code(422);
        return refuse(r, null, { payment_hash: e.body.payment_hash });
      }
      return { ok: true, status: r.status, duplicate: r.duplicate };
    }
    if ((e.type === "P_CONFIRM" || e.type === "VERDICT") && escrow && opts.identities) {
      if (e.to !== opts.identities.engine) {
        reply.code(422);
        return refuse(block("SIGNATURE_INVALID", { subject: `the ${e.type} message` }), null, echo);
      }
      const r =
        e.type === "P_CONFIRM"
          ? await escrow.handlePConfirm(e.body, e.from)
          : await escrow.handleVerdict(e.body, e.from);
      if (!r.ok) {
        reply.code(422);
        return refuse(r, null, echo);
      }
      return { ok: true };
    }
    reply.code(501);
    return refuse(
      block("MALFORMED_INTENT", { reason: `${e.type} messages are not handled by the engine yet` }),
      null,
      echo,
    );
  });

  app.get("/v0/events", { websocket: true }, (socket) => {
    const send = (e: EngineEvent) => socket.send(JSON.stringify(e));
    for (const e of bus.replay()) send(e);
    const off = bus.subscribe(send);
    socket.on("close", off);
  });

  return app;
}
