import { createHash, randomUUID } from "node:crypto";
import {
  contractHash,
  type Envelope,
  isFresh,
  type OfferedContract,
  offeredContractSchema,
  parseAmount,
  type Signer,
  signPayload,
  type TaskContract,
  taskId,
  verdictRecordSchema,
  verifyPayload,
} from "@verdict/protocol";
import type { PaymentStatusEvent, WalletPort } from "@verdict/wallet";
import { type Attempt, produceDelivery } from "../agent/attempts.js";
import type { Generated, Generator } from "../agent/generate.js";
import type { CheckFn } from "../agent/selfcheck.js";
import { bundleDelivery, type StoredDelivery, storeDelivery } from "../store.js";
import type { StreamHub } from "../stream.js";

/** Lowest CLTV delta the node accepts; 39 blocks x 600 s = 23 400 s (ADR-021). */
export const MIN_CLTV_DELTA = 39;
const SECONDS_PER_BLOCK = 600;

export type WorkerState =
  | "OFFERED"
  | "ACCEPTED"
  | "INVOICE_SENT"
  | "ESCROW_LOCKED"
  | "GENERATING"
  | "DELIVERED"
  /** The verifier's verdict arrived. */
  | "RELEASED"
  | "WITHHELD"
  /** Paid: the preimage was released and the claim was made. */
  | "CLAIMED"
  /** An honest worker whose delivery failed: the held invoice was cancelled so the buyer's funds are released. */
  | "CANCELLED"
  /** Demo switch "worker disappears": stops right after the lock; never works, delivers, claims or cancels. */
  | "ABANDONED"
  | "FAILED"
  | "REFUSED";

export interface WorkerTask {
  taskId: string;
  paymentHash: string;
  state: WorkerState;
  reason?: string;
  delivery?: StoredDelivery & { files: string[]; generated: Omit<Generated, "files"> };
  /** Shown in the UI worker lane as "attempt n/3". */
  progress?: { attempt: number; max_attempts: number };
  /** One line per attempt: speed and what the local self-check said. */
  attempts?: {
    n: number;
    seconds: number;
    tokens_per_sec: number | null;
    self_check: "PASS" | "FAIL" | "WITHHOLD" | "not run";
  }[];
  /** Last verdict the verifier signed for this task, as the UI worker lane shows it. */
  verdict?: { attempt: number; verdict: "RELEASE" | "WITHHOLD"; exit_code: number };
  /** True when the demo switch made the worker deliver a deliberately broken file. */
  sabotaged?: boolean;
  /** Demo switches as they were when this task started (read once at escrow lock, the worker's own record). */
  toggles?: { sabotaged: boolean; disappears: boolean };
}

export interface WorkerNodeDeps {
  signer: Signer;
  engineId: string;
  engineUrl: string;
  wallet: WalletPort;
  assetId: string;
  precision: number;
  generator: Generator;
  /** Local run of the verifier package before announcing the delivery. Absent: single attempt, no check. */
  check?: CheckFn;
  /** Live token stream for the UI worker lane. */
  stream?: StreamHub;
  /** Demo switch, read at the start of each task. */
  sabotaged?: () => boolean;
  /** Demo switch "worker disappears": after the verdict the worker neither claims nor cancels. */
  disappears?: () => boolean;
  /** The verifier's public id; its P_CONFIRM, VERDICT and PREIMAGE are the only ones the worker acts on. */
  verifierId?: string;
  /** Hash of the verification package this worker self-checks with. When set, an offer naming another package is refused. */
  packageSha256?: () => Promise<string>;
  /** How long to wait for P_CONFIRM before the HODL invoice is made, ms. */
  confirmWaitMs?: number;
  deliveryRoot: string;
  now?: () => Date;
  fetchImpl?: typeof fetch;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
  /** Test-only: a dishonest worker that tampers with its invoice. Refused when VERDICT_MODE=demo. */
  tamper?: { invoiceHash?: string; invoiceAssetUnits?: bigint };
}

export type OfferAnswer = { ok: true; task_id: string } | { ok: false; reason: string };

const isoSec = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");

/**
 * Worker protocol side: checks a TASK_OFFER, countersigns it (TASK_ACCEPT), issues the HODL invoice for the
 * buyer's hash H, waits until the buyer's HTLC is held (Claimable), then lets the agent produce the deliverable.
 * The worker never sees the preimage P.
 */
export class WorkerNode {
  private readonly tasks = new Map<string, WorkerTask>();
  private readonly byHash = new Map<string, WorkerTask>();
  private readonly contracts = new Map<string, TaskContract>();
  private stop: (() => void) | undefined;

  constructor(private readonly d: WorkerNodeDeps) {
    if (d.tamper && process.env.VERDICT_MODE === "demo")
      throw new Error("tamper switches are not allowed when VERDICT_MODE=demo");
  }

  private now(): Date {
    return (this.d.now ?? (() => new Date()))();
  }
  private log(msg: string, extra?: Record<string, unknown>): void {
    this.d.log?.(msg, extra);
  }

  start(): void {
    this.stop = this.d.wallet.onPaymentStatus((e) => this.onPayment(e));
  }
  close(): void {
    this.stop?.();
  }

  get(taskIdValue: string): WorkerTask | undefined {
    return this.tasks.get(taskIdValue);
  }
  list(): WorkerTask[] {
    return [...this.tasks.values()];
  }

  /** Routes an incoming envelope: TASK_OFFER from the engine; P_CONFIRM, VERDICT and PREIMAGE from the verifier. */
  async handleMessage(env: Envelope): Promise<OfferAnswer> {
    if (env.type === "TASK_OFFER") return this.handleOffer(env);
    if (env.type === "P_CONFIRM" || env.type === "VERDICT" || env.type === "PREIMAGE")
      return this.handleFromVerifier(env);
    return { ok: false, reason: `${env.type} is not handled by the worker` };
  }

  /** Returns the HTTP-level answer; the rest of the protocol runs in the background. */
  async handleOffer(env: Envelope): Promise<OfferAnswer> {
    const me = this.d.signer.publicId;
    if (env.type !== "TASK_OFFER") return { ok: false, reason: "only TASK_OFFER is handled" };
    if (env.from !== this.d.engineId || env.to !== me)
      return {
        ok: false,
        reason: "the offer is not from this buyer or not addressed to this worker",
      };
    if (!isFresh(env.sent_at, this.now().getTime()))
      return { ok: false, reason: "the message is too old or from the future" };
    if (
      !(await verifyPayload(
        "TASK_OFFER",
        env as unknown as Record<string, unknown>,
        env.from,
        env.sig,
      ))
    )
      return { ok: false, reason: "the envelope signature is invalid" };
    const parsed = offeredContractSchema.safeParse(env.body);
    if (!parsed.success)
      return { ok: false, reason: "the offer does not follow the protocol format" };
    const offer = parsed.data;
    const problem = await this.checkOffer(offer);
    if (problem) {
      this.log("offer refused", { reason: problem });
      return { ok: false, reason: problem };
    }
    const tid = taskId(offer);
    if (this.tasks.has(tid)) return { ok: true, task_id: tid };
    const task: WorkerTask = {
      taskId: tid,
      paymentHash: offer.payment.payment_hash,
      state: "OFFERED",
    };
    this.tasks.set(tid, task);
    this.byHash.set(task.paymentHash, task);
    void this.accept(task, offer).catch((e: unknown) => this.fail(task, e));
    return { ok: true, task_id: tid };
  }

  /** The cltv delta this worker will put on the invoice, or a reason it cannot honour the lock window. */
  lockPlan(offer: OfferedContract): { delta: number } | { reason: string } {
    const untilDeadline = Math.max(
      0,
      Math.ceil((Date.parse(offer.task.deadline) - this.now().getTime()) / 1000),
    );
    const required = untilDeadline + offer.task.max_verify_seconds + offer.safety_margin_seconds;
    const delta = Math.max(
      MIN_CLTV_DELTA,
      Math.ceil(required / SECONDS_PER_BLOCK),
      offer.payment.expiry_blocks,
    );
    if (delta * SECONDS_PER_BLOCK > offer.max_lock_seconds)
      return {
        reason: `the lock window needed (${delta * SECONDS_PER_BLOCK} s) is longer than the contract allows (${offer.max_lock_seconds} s)`,
      };
    return { delta };
  }

  private async checkOffer(offer: OfferedContract): Promise<string | undefined> {
    const me = this.d.signer.publicId;
    if (offer.buyer !== this.d.engineId)
      return "the contract buyer is not the engine this worker serves";
    if (offer.worker !== me) return "the contract names a different worker";
    if (
      !(await verifyPayload(
        "TASK_CONTRACT",
        offer as unknown as Record<string, unknown>,
        offer.buyer,
        offer.signatures.buyer,
      ))
    )
      return "the buyer's contract signature is invalid";
    if (offer.payment.asset_id !== this.d.assetId)
      return "the contract pays in an asset this worker does not accept";
    if (offer.payment.payee_node_id !== (await this.d.wallet.nodeId()))
      return "the contract names a different payee node than this worker's";
    try {
      if (parseAmount(offer.payment.amount, this.d.precision) <= 0n)
        return "the price must be positive";
    } catch {
      return "the price is not a valid amount";
    }
    if (Date.parse(offer.task.deadline) <= this.now().getTime())
      return "the deadline has already passed";
    if (this.d.packageSha256) {
      let local: string;
      try {
        local = await this.d.packageSha256();
      } catch {
        return "this worker cannot read its copy of the verification package";
      }
      if (local !== offer.verifier.package_sha256)
        return "this worker's verification package is not the one the contract names, so its self-check would not match the verifier's";
    }
    const plan = this.lockPlan(offer);
    if ("reason" in plan) return plan.reason;
    return undefined;
  }

  private async accept(task: WorkerTask, offer: OfferedContract): Promise<void> {
    const body = { ...offer } as Record<string, unknown>;
    // Both parties sign the same unsigned body.
    const { signatures: _s, ...unsigned } = body as { signatures: unknown } & Record<
      string,
      unknown
    >;
    const workerSig = await signPayload(this.d.signer, "TASK_CONTRACT", unsigned);
    const contract: TaskContract = {
      ...offer,
      signatures: { buyer: offer.signatures.buyer, worker: workerSig },
    };
    if (
      contractHash(contract as unknown as Record<string, unknown>) !==
      contractHash(offer as unknown as Record<string, unknown>)
    )
      throw new Error("countersigning changed the contract hash");
    this.contracts.set(task.taskId, contract);

    const accepted = await this.post("TASK_ACCEPT", task.taskId, contract);
    if (!accepted.ok) {
      task.state = "REFUSED";
      task.reason = accepted.reason;
      this.log("TASK_ACCEPT refused by engine", { reason: accepted.reason });
      return;
    }
    task.state = "ACCEPTED";

    // Spec 6, steps 6-8: the invoice is made only once the verifier holds the secret for this hash.
    if (this.d.verifierId && !(await this.waitForConfirm(task.taskId))) {
      task.state = "REFUSED";
      task.reason =
        "the verifier did not confirm that it holds the release secret, so no invoice was made";
      this.log(task.reason, { task: task.taskId });
      return;
    }

    const plan = this.lockPlan(offer);
    if ("reason" in plan) throw new Error(plan.reason);
    const units = parseAmount(offer.payment.amount, this.d.precision);
    const inv = await this.d.wallet.createHodlInvoice({
      paymentHash: this.d.tamper?.invoiceHash ?? offer.payment.payment_hash,
      assetId: offer.payment.asset_id,
      assetAmount: this.d.tamper?.invoiceAssetUnits ?? units,
      amtMsat: 3_000_000n,
      expirySec: offer.payment.expiry_seconds,
      minFinalCltvExpiryDelta: plan.delta,
    });
    const sent = await this.post("HODL_INVOICE", task.taskId, {
      bolt11: inv.bolt11,
      payment_hash: offer.payment.payment_hash,
    });
    if (!sent.ok) {
      task.state = "REFUSED";
      task.reason = sent.reason;
      await this.d.wallet.cancelHodlInvoice(inv.paymentHash).catch(() => undefined);
      return;
    }
    task.state = "INVOICE_SENT";
  }

  private readonly confirmed = new Set<string>();
  private readonly confirmWaiters = new Map<string, () => void>();

  private waitForConfirm(tid: string): Promise<boolean> {
    if (this.confirmed.has(tid)) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.confirmWaiters.delete(tid);
        resolve(false);
      }, this.d.confirmWaitMs ?? 60_000);
      this.confirmWaiters.set(tid, () => {
        clearTimeout(timer);
        this.confirmWaiters.delete(tid);
        resolve(true);
      });
    });
  }

  /** P_CONFIRM, VERDICT and PREIMAGE. Only the verifier named in the contract is believed. */
  private async handleFromVerifier(
    env: Extract<Envelope, { type: "P_CONFIRM" | "VERDICT" | "PREIMAGE" }>,
  ): Promise<OfferAnswer> {
    const me = this.d.signer.publicId;
    const contract = this.contracts.get(env.task_id);
    const task = this.tasks.get(env.task_id);
    if (!contract || !task) return { ok: false, reason: "unknown task" };
    if (env.to !== me || env.from !== this.d.verifierId || env.from !== contract.verifier.public_id)
      return { ok: false, reason: "the message is not from this task's verifier" };
    if (!isFresh(env.sent_at, this.now().getTime()))
      return { ok: false, reason: "the message is too old or from the future" };
    if (
      !(await verifyPayload(env.type, env as unknown as Record<string, unknown>, env.from, env.sig))
    )
      return { ok: false, reason: `the ${env.type} signature is invalid` };

    if (env.type === "P_CONFIRM") {
      const b = env.body;
      if (
        b.payment_hash !== task.paymentHash ||
        b.task_id !== task.taskId ||
        b.package_sha256 !== contract.verifier.package_sha256
      )
        return { ok: false, reason: "the confirmation does not match the contract" };
      this.confirmed.add(task.taskId);
      this.confirmWaiters.get(task.taskId)?.();
      return { ok: true, task_id: task.taskId };
    }
    if (env.type === "VERDICT") {
      const parsed = verdictRecordSchema.safeParse(env.body);
      if (!parsed.success || parsed.data.payment_hash !== task.paymentHash)
        return { ok: false, reason: "the verdict does not match the contract" };
      const { verifier_sig, ...unsigned } = parsed.data;
      if (!(await verifyPayload("VERDICT", unsigned, env.from, verifier_sig)))
        return { ok: false, reason: "the verdict signature is invalid" };
      // One verdict per delivery: a replayed or out-of-order VERDICT must not flip a settled task.
      if (task.state !== "DELIVERED")
        return { ok: false, reason: `a verdict is not expected while the task is ${task.state}` };
      const v = parsed.data;
      task.verdict = { attempt: v.attempt, verdict: v.verdict, exit_code: v.exit_code };
      this.log("verdict received", { task: task.taskId, verdict: v.verdict, attempt: v.attempt });
      if (v.verdict === "RELEASE") {
        task.state = "RELEASED";
      } else {
        task.state = "WITHHELD";
        void this.onWithheld(task).catch((e: unknown) => this.fail(task, e));
      }
      return { ok: true, task_id: task.taskId };
    }
    // PREIMAGE: only a secret that hashes to the contract's payment hash is ever used.
    const p = env.body;
    if (
      p.payment_hash !== task.paymentHash ||
      createHash("sha256").update(Buffer.from(p.preimage_hex, "hex")).digest("hex") !==
        task.paymentHash
    )
      return { ok: false, reason: "the secret does not match the payment hash" };
    if (task.toggles?.disappears ?? this.d.disappears?.()) {
      task.state = "ABANDONED";
      this.log("DEMO: worker disappears, not claiming", { task: task.taskId });
      return { ok: true, task_id: task.taskId };
    }
    await this.d.wallet.claimHodlInvoice(task.paymentHash, p.preimage_hex);
    task.state = "CLAIMED";
    this.log("claimed the payment", { task: task.taskId });
    return { ok: true, task_id: task.taskId };
  }

  /** An honest worker whose delivery was refused cancels the held invoice so the buyer's funds come back at once. */
  private async onWithheld(task: WorkerTask): Promise<void> {
    if (task.toggles?.disappears ?? this.d.disappears?.()) {
      task.state = "ABANDONED";
      this.log("DEMO: worker disappears, not cancelling", { task: task.taskId });
      return;
    }
    await this.d.wallet.cancelHodlInvoice(task.paymentHash);
    task.state = "CANCELLED";
    this.log("delivery was refused: invoice cancelled, buyer's funds are released", {
      task: task.taskId,
    });
  }

  private onPayment(e: PaymentStatusEvent): void {
    if (e.role !== "payee") return;
    const task = this.byHash.get(e.paymentHash);
    if (!task) return;
    if (e.status === "Claimable" && task.state === "INVOICE_SENT") {
      task.state = "ESCROW_LOCKED";
      // Demo switches are read here, at the start of the task: a change applies from the NEXT task on.
      task.toggles = {
        sabotaged: this.d.sabotaged?.() ?? false,
        disappears: this.d.disappears?.() ?? false,
      };
      if (task.toggles.disappears) {
        // Demo "worker disappears": funds are locked, then silence. No work, no delivery, no claim, no cancel.
        task.state = "ABANDONED";
        task.reason = "demo: the worker stopped after the escrow locked";
        this.log("DEMO: worker disappears after the lock, doing nothing", { task: task.taskId });
        return;
      }
      this.log("escrow locked, starting work", { task: task.taskId, toggles: task.toggles });
      void this.work(task).catch((err: unknown) => this.fail(task, err));
    } else if (
      e.status === "Failed" &&
      (task.state === "INVOICE_SENT" ||
        task.state === "ESCROW_LOCKED" ||
        task.state === "GENERATING")
    ) {
      task.state = "FAILED";
      task.reason = "the buyer's payment failed or was cancelled";
    }
  }

  private async work(task: WorkerTask): Promise<void> {
    const contract = this.contracts.get(task.taskId);
    if (!contract) throw new Error("no contract for this task");
    task.state = "GENERATING";
    const sabotaged = task.toggles?.sabotaged ?? this.d.sabotaged?.() ?? false;
    const { best, attempts } = await produceDelivery({
      generator: this.d.generator,
      ...(this.d.check ? { check: this.d.check } : {}),
      spec: contract.task.spec,
      sabotaged,
      ...(this.d.stream
        ? { hooksFor: (n: number) => this.d.stream?.attempt(task.taskId, n) ?? {} }
        : {}),
      onProgress: (p) => {
        task.progress = { attempt: p.attempt, max_attempts: p.maxAttempts };
      },
      log: (msg, extra) => this.log(msg, { task: task.taskId, ...extra }),
    });
    const { files, ...generated } = best.generated;
    const stored = storeDelivery(this.d.deliveryRoot, task.taskId, 1, files);
    task.delivery = { ...stored, files: files.map((f) => f.path), generated };
    task.attempts = attempts.map((a: Attempt) => ({
      n: a.n,
      seconds: Number((a.generated.generationMs / 1000).toFixed(1)),
      tokens_per_sec:
        a.generated.tokensPerSec === null ? null : Number(a.generated.tokensPerSec.toFixed(1)),
      self_check: a.check?.outcome ?? "not run",
    }));
    if (sabotaged) task.sabotaged = true;
    task.state = "DELIVERED";
    this.log("delivery ready", {
      task: task.taskId,
      dirHash: stored.dirHash,
      generationMs: generated.generationMs,
    });
    if (this.d.verifierId) {
      const exit = best.check?.outcome === "PASS" ? 0 : best.check?.outcome === "FAIL" ? 1 : -1;
      const sent = await this.postTo(
        contract.verifier.endpoint,
        "DELIVER",
        task.taskId,
        contract.verifier.public_id,
        {
          attempt: 1,
          delivery_sha256: stored.dirHash,
          bundle_b64: bundleDelivery(stored.dir),
          self_check_exit_code: exit,
        },
      );
      if (!sent.ok) throw new Error(`the verifier did not take the delivery (${sent.reason})`);
      this.log("delivery sent to the verifier", { task: task.taskId });
    }
  }

  private fail(task: WorkerTask, e: unknown): void {
    task.state = "FAILED";
    task.reason = e instanceof Error ? e.message : "unknown error";
    this.log("task failed", { task: task.taskId, reason: task.reason });
  }

  private post(
    type: "TASK_ACCEPT" | "HODL_INVOICE",
    tid: string,
    body: unknown,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    return this.postTo(this.d.engineUrl, type, tid, this.d.engineId, body);
  }

  private async postTo(
    baseUrl: string,
    type: "TASK_ACCEPT" | "HODL_INVOICE" | "DELIVER",
    tid: string,
    to: string,
    body: unknown,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const env: Record<string, unknown> = {
      v: 0,
      id: randomUUID(),
      task_id: tid,
      from: this.d.signer.publicId,
      to,
      sent_at: isoSec(this.now()),
      type,
      body,
    };
    env.sig = await signPayload(this.d.signer, type, env);
    const f = this.d.fetchImpl ?? fetch;
    const r = await f(`${baseUrl}/v0/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(env),
      signal: AbortSignal.timeout(30_000),
    });
    if (r.ok) return { ok: true };
    const j = (await r.json().catch(() => ({}))) as { code?: string; message?: string };
    return { ok: false, reason: `${j.code ?? r.status}: ${j.message ?? "refused"}` };
  }
}
