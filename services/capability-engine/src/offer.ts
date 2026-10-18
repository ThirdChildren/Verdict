import { randomUUID } from "node:crypto";
import {
  type OfferedContract,
  offeredContractSchema,
  randomHex32,
  type Signer,
  type SpendIntent,
  sealPreimage,
  sha256Hex,
  signPayload,
  spendIntentSchema,
  taskId,
} from "@verdict/protocol";
import type { Catalogue } from "./catalogue.js";
import type { EventBus } from "./events.js";
import type { Ledger } from "./ledger/index.js";
import { type Block, block } from "./policy/index.js";

export interface OfferConfig {
  ledger: Ledger;
  bus: EventBus;
  engineSigner: Signer;
  /** The packages the engine may name. When set, a contract can only carry a hash found here. */
  catalogue?: Catalogue;
  /** `packageSha256` is the default for a task with no bound type, and only while the catalogue has at most one entry. */
  verifier: { publicId: string; endpoint: string; packageSha256: string };
  /** Base URL of the worker service (loopback). */
  workerUrl: string;
  assetId: string;
  maxLockSeconds: number;
  safetyMarginSeconds: number;
  maxVerifySeconds: number;
  /** How long the HODL invoice may stay payable, seconds. */
  expirySeconds: number;
  /** Intended CLTV delta, blocks (documented in the contract; the lock is read from the invoice later). */
  expiryBlocks: number;
  now: () => Date;
  fetchImpl?: typeof fetch;
}

const isoSec = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");

/**
 * Builds and signs the TASK_OFFER for an accepted spend intent (spec 6, step 4). Generates the preimage P here,
 * seals it to the verifier's key and keeps it in the ledger vault. The worker only ever gets H.
 */
export class OfferService {
  constructor(private readonly c: OfferConfig) {}

  async offerFor(
    intentSha: string,
  ): Promise<Block | { ok: true; taskId: string; paymentHash: string }> {
    const { ledger, now } = this.c;
    const existing = ledger.getOfferByIntent(intentSha);
    if (existing) return { ok: true, taskId: existing.taskId, paymentHash: existing.paymentHash };
    const accepted = ledger.getAcceptedIntent(intentSha);
    const parsed = spendIntentSchema.safeParse(accepted?.intent);
    if (!accepted || !parsed.success)
      return block("MALFORMED_INTENT", {
        reason: "no accepted spend request to build an offer from",
      });
    const intent: SpendIntent = parsed.data;

    let info: { public_id: string; node_id: string };
    try {
      info = await this.workerInfo();
    } catch (e) {
      return block("MALFORMED_INTENT", {
        reason: `the worker could not be reached (${e instanceof Error ? e.message : "unknown error"}); nothing was signed`,
      });
    }
    if (info.public_id !== intent.counterparty)
      return block("COUNTERPARTY_NOT_ALLOWED", { counterparty: info.public_id });

    let packageSha256: string;
    try {
      packageSha256 = this.packageFor(accepted.capHash);
    } catch (e) {
      return block("MALFORMED_INTENT", {
        reason: `${e instanceof Error ? e.message : "the test package could not be chosen"}; nothing was signed`,
      });
    }

    const preimageHex = randomHex32();
    const paymentHash = sha256Hex(Buffer.from(preimageHex, "hex"));
    const body = {
      version: "verdict-task/0" as const,
      buyer: this.c.engineSigner.publicId,
      worker: intent.counterparty,
      capability_hash: accepted.capHash,
      intent_sha256: intentSha,
      payment: {
        asset_id: this.c.assetId,
        amount: intent.amount,
        payment_hash: paymentHash,
        payee_node_id: info.node_id,
        expiry_blocks: this.c.expiryBlocks,
        expiry_seconds: this.c.expirySeconds,
      },
      task: {
        category: intent.category,
        spec: intent.task_spec,
        deadline: intent.deadline,
        max_verify_seconds: this.c.maxVerifySeconds,
      },
      verifier: {
        public_id: this.c.verifier.publicId,
        endpoint: this.c.verifier.endpoint,
        package_sha256: packageSha256,
        entrypoint: "./verify.sh",
        rule: "EXIT_0_AND_SCHEMA_VALID" as const,
      },
      max_lock_seconds: this.c.maxLockSeconds,
      safety_margin_seconds: this.c.safetyMarginSeconds,
    };
    const offer: OfferedContract = offeredContractSchema.parse({
      ...body,
      signatures: { buyer: await signPayload(this.c.engineSigner, "TASK_CONTRACT", body) },
    });
    const tid = taskId(offer);
    ledger.recordOffer(
      {
        intentSha256: intentSha,
        paymentHash,
        taskId: tid,
        contract: offer,
        preimageHex,
        sealedPreimage: await sealPreimage(preimageHex, this.c.verifier.publicId),
      },
      now(),
    );
    this.c.bus.publish({ type: "TASK_STATE", data: { task_id: tid, state: "OFFERED" } }, now());

    const sent = await this.post(info.public_id, "TASK_OFFER", tid, offer);
    if (!sent.ok) return sent;
    return { ok: true, taskId: tid, paymentHash };
  }

  /** The package hash for a task: its bound type, else the single default. Throws (fail closed) for anything not in the catalogue. */
  private packageFor(capHash: string): string {
    const cat = this.c.catalogue;
    const bound = this.c.ledger.getPackage(capHash);
    if (bound) {
      if (cat && !cat.byHash(bound.packageSha256))
        throw new Error("the task's test package is not in the engine's catalogue");
      return bound.packageSha256;
    }
    if (cat && cat.entries.length !== 1)
      throw new Error("no verifiable task type is bound to this permission");
    const dflt = this.c.verifier.packageSha256;
    if (cat && !cat.byHash(dflt))
      throw new Error("the default test package is not in the engine's catalogue");
    return dflt;
  }

  private async workerInfo(): Promise<{ public_id: string; node_id: string }> {
    const f = this.c.fetchImpl ?? fetch;
    const r = await f(`${this.c.workerUrl}/v0/info`, { signal: AbortSignal.timeout(5000) });
    const j = (await r.json()) as { public_id?: unknown; node_id?: unknown };
    if (!r.ok || typeof j.public_id !== "string" || typeof j.node_id !== "string")
      throw new Error("bad /v0/info answer");
    return { public_id: j.public_id, node_id: j.node_id };
  }

  private async post(
    to: string,
    type: string,
    tid: string,
    body: unknown,
  ): Promise<Block | { ok: true }> {
    const env: Record<string, unknown> = {
      v: 0,
      id: randomUUID(),
      task_id: tid,
      from: this.c.engineSigner.publicId,
      to,
      sent_at: isoSec(this.c.now()),
      type,
      body,
    };
    env.sig = await signPayload(this.c.engineSigner, type, env);
    try {
      const f = this.c.fetchImpl ?? fetch;
      const r = await f(`${this.c.workerUrl}/v0/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(env),
        signal: AbortSignal.timeout(10_000),
      });
      if (!r.ok)
        return block("MALFORMED_INTENT", {
          reason: `the worker refused the offer (HTTP ${r.status})`,
        });
      return { ok: true };
    } catch (e) {
      return block("MALFORMED_INTENT", {
        reason: `the offer could not be delivered to the worker (${e instanceof Error ? e.message : "unknown error"})`,
      });
    }
  }
}
