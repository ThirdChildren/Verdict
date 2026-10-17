import {
  capabilityHash,
  capabilitySchema,
  childCapabilitySchema,
  contractHash,
  hashObj,
  parseAmount,
  spendIntentSchema,
  type TaskContract,
  taskContractSchema,
  taskId,
  type VerdictRecord,
  verdictRecordSchema,
  verifyPayload,
} from "@verdict/protocol";
import { toEngineInvoice, WalletError, type WalletPort } from "@verdict/wallet";
import type { EventBus } from "./events.js";
import type { Ledger } from "./ledger/index.js";
import {
  authorizePaymentChecks,
  type Block,
  BlockError,
  block,
  checkContractLink,
} from "./policy/index.js";
import type { TaskTracker } from "./tasks.js";
import type { VerifierLink } from "./verifier-link.js";

export interface EscrowDeps {
  ledger: Ledger;
  /** The buyer's wallet daemon (WalletClient). The engine never holds a node or keys itself. */
  wallet: WalletPort;
  bus: EventBus;
  /** contract.buyer must be this id: the engine is the buyer authority. */
  engineId: string;
  precision: number;
  now: () => Date;
  preapprovedWorkers: readonly string[];
  /** Task state machine, announced to the UI. */
  tasks?: TaskTracker;
  /** The verifier's public id. With `verifier` set, a payment waits for its P_CONFIRM. */
  verifierId?: string;
  verifier?: VerifierLink;
  /** Current block height (bitcoind). Absent or failing: the lock height is simply not recorded. */
  height?: () => Promise<number>;
}

class UnconfirmedPayment extends Error {}

export type EscrowResult =
  | { ok: true; status: "Pending" | "Claimable" | "Settled" | "Failed"; duplicate: boolean }
  | Block;

/** Both parties sign the contract with signatures stripped (type TASK_CONTRACT, see protocol canonical tests). */
export async function contractSignaturesValid(c: TaskContract): Promise<boolean> {
  const body = c as unknown as Record<string, unknown>;
  return (
    (await verifyPayload("TASK_CONTRACT", body, c.buyer, c.signatures.buyer)) &&
    (await verifyPayload("TASK_CONTRACT", body, c.worker, c.signatures.worker))
  );
}

/**
 * authorizePayment: the only road from the engine to `wallet.pay` (invariant 1).
 * Order: signatures and invoice checks -> reserve in one transaction -> pay. Reservations then move only on wallet events.
 */
export class Escrow {
  constructor(private readonly d: EscrowDeps) {}

  /** TASK_ACCEPT: keep the worker-signed contract until its invoice arrives. */
  async acceptContract(raw: unknown, from: string): Promise<Block | { ok: true; taskId: string }> {
    const parsed = taskContractSchema.safeParse(raw);
    if (!parsed.success)
      return block("MALFORMED_INTENT", {
        reason: "the task contract does not follow the protocol format",
      });
    const c = parsed.data;
    if (from !== c.worker || c.buyer !== this.d.engineId || !(await contractSignaturesValid(c)))
      return block("SIGNATURE_INVALID", { subject: "the task contract" });
    if (!this.d.ledger.getCapability(c.capability_hash)) return block("PARENT_MISMATCH");

    // The contract must fulfil a spend intent the engine accepted, and be the offer the engine itself signed.
    const stored = this.d.ledger.getAcceptedIntent(c.intent_sha256);
    const intent = spendIntentSchema.safeParse(stored?.intent);
    const link = checkContractLink(c, {
      precision: this.d.precision,
      holder: this.d.ledger.holderOf(c.capability_hash),
      accepted:
        stored && intent.success
          ? {
              intentSha256: c.intent_sha256,
              capHash: stored.capHash,
              intent: intent.data,
              signedBy: stored.signedBy,
            }
          : undefined,
    });
    if (!link.ok) return link;
    const offered = this.d.ledger.getOfferContract(c.payment.payment_hash);
    if (
      typeof offered !== "object" ||
      offered === null ||
      contractHash(offered as Record<string, unknown>) !== contractHash(c)
    )
      return block("MALFORMED_INTENT", {
        reason: "the contract is not the offer this engine signed",
      });
    const id = taskId(c);
    try {
      this.d.ledger.registerContract(c.payment.payment_hash, id, c, this.d.now());
    } catch {
      return block("MALFORMED_INTENT", {
        reason: "a different contract already uses this payment hash",
      });
    }
    this.d.tasks?.move(id, "ACCEPTED");
    if (this.d.verifier) void this.deposit(id, c);
    return { ok: true, taskId: id };
  }

  /** P_DEPOSIT to the verifier (spec 6, step 6). A failure is shown, and the payment then never starts (no P_CONFIRM). */
  private async deposit(id: string, c: TaskContract): Promise<void> {
    const sealed = this.d.ledger.sealedPreimageFor(c.payment.payment_hash);
    const r = sealed
      ? await this.d.verifier?.deposit(id, c, sealed)
      : ({ ok: false, reason: "no sealed secret stored for this task" } as const);
    if (r?.ok) {
      this.d.tasks?.move(id, "P_DEPOSITED");
      return;
    }
    const b = block("MALFORMED_INTENT", {
      reason: `the verifier did not take the deposit (${r && !r.ok ? r.reason : "unknown"}); nothing was paid`,
    });
    this.d.bus.publish(
      {
        type: "BLOCKED",
        data: { code: b.code, message: b.message, intent: { task_id: id }, cap_id: null },
      },
      this.d.now(),
    );
  }

  /** P_CONFIRM: the verifier holds the secret for this hash and has the same package the contract names. */
  async handlePConfirm(
    body: { task_id: string; payment_hash: string; package_sha256: string },
    from: string,
  ): Promise<Block | { ok: true }> {
    const stored = this.d.ledger.getContract(body.payment_hash);
    const c = taskContractSchema.safeParse(stored?.contract);
    if (
      !stored ||
      !c.success ||
      from !== this.d.verifierId ||
      c.data.verifier.public_id !== from ||
      stored.taskId !== body.task_id ||
      c.data.verifier.package_sha256 !== body.package_sha256
    )
      return block("SIGNATURE_INVALID", { subject: "the verifier's confirmation" });
    this.d.ledger.recordPConfirm(body.payment_hash, body, this.d.now());
    // The confirmation can overtake the HTTP answer of the deposit itself.
    this.d.tasks?.move(stored.taskId, "P_DEPOSITED");
    this.d.tasks?.move(stored.taskId, "P_CONFIRMED");
    return { ok: true };
  }

  /** VERDICT: check the signed record against the contract, keep it, show it. Money only moves on wallet events. */
  async handleVerdict(
    raw: unknown,
    from: string,
  ): Promise<Block | { ok: true; duplicate: boolean }> {
    const parsed = verdictRecordSchema.safeParse(raw);
    const bad = block("SIGNATURE_INVALID", { subject: "the verifier's verdict" });
    if (!parsed.success) return bad;
    const v: VerdictRecord = parsed.data;
    const stored = this.d.ledger.getContract(v.payment_hash);
    const c = taskContractSchema.safeParse(stored?.contract);
    if (!stored || !c.success) return bad;
    const { verifier_sig, ...unsigned } = v;
    if (
      from !== this.d.verifierId ||
      c.data.verifier.public_id !== from ||
      stored.taskId !== v.task_id ||
      v.contract_sha256 !== contractHash(c.data as unknown as Record<string, unknown>) ||
      v.verifier_package_sha256 !== c.data.verifier.package_sha256 ||
      !(await verifyPayload("VERDICT", unsigned, from, verifier_sig))
    )
      return bad;
    if (!this.d.ledger.recordVerdict(v.payment_hash, v.attempt, v, this.d.now()))
      return { ok: true, duplicate: true };
    this.d.bus.publish({ type: "VERDICT", data: v }, this.d.now());
    this.d.tasks?.move(v.task_id, "DELIVERED", v.attempt);
    this.d.tasks?.move(
      v.task_id,
      v.verdict === "RELEASE" ? "VERDICT_RELEASE" : "VERDICT_WITHHOLD",
      v.attempt,
    );
    return { ok: true, duplicate: false };
  }

  /** HODL_INVOICE: validate against the stored contract, reserve, then pay. */
  async authorizePayment(bolt11: string, paymentHash: string, from: string): Promise<EscrowResult> {
    const { ledger, wallet, precision } = this.d;
    try {
      const stored = ledger.getContract(paymentHash);
      const c = taskContractSchema.safeParse(stored?.contract);
      if (!stored || !c.success) return block("INVOICE_HASH_MISMATCH");
      const contract = c.data;
      if (from !== contract.worker)
        return block("SIGNATURE_INVALID", { subject: "the invoice message" });
      // A repeat never pays twice.
      const prior = ledger.getByPaymentHash(paymentHash);
      if (prior) return { ok: true, status: "Pending", duplicate: true };
      // Never lock funds for a task whose release secret the verifier has not confirmed (spec 6, step 7).
      if (this.d.verifier && !ledger.hasPConfirm(paymentHash))
        return block("MALFORMED_INTENT", {
          reason:
            "the verifier has not confirmed that it holds the release secret for this task, so no payment was started",
        });

      const capHash = contract.capability_hash;
      const cap = childCapabilitySchema.safeParse(ledger.getCapability(capHash));
      if (!cap.success) return block("PARENT_MISMATCH");
      const ancestorPayees = ledger.ancestors(capHash).map((a) => {
        const q = capabilitySchema.safeParse(a);
        if (!q.success) throw new Error("unreadable ancestor");
        return q.data.allowed_payees;
      });
      const now = this.d.now();
      const decoded = await wallet.decodeInvoice(bolt11);
      const decision = authorizePaymentChecks(
        cap.data,
        toEngineInvoice(decoded, now),
        parseAmount(contract.payment.amount, precision),
        contract,
        {
          now,
          precision,
          capSignatureValid: await verifyPayload(
            "CAP_CHILD",
            cap.data as unknown as Record<string, unknown>,
            cap.data.issuer,
            cap.data.signature,
          ),
          contractSignaturesValid: await contractSignaturesValid(contract),
          revoked: ledger.isRevoked(capHash),
          capHash: capabilityHash(cap.data),
          remaining: ledger.remaining(capHash),
          paymentsMade: ledger.paymentsMade(capHash),
          preapprovedWorkers: this.d.preapprovedWorkers,
          ancestorPayees,
        },
      );
      if (!decision.ok) return decision;

      // Reserve BEFORE the wallet is touched (invariant 3).
      const reserved = ledger.reserve({
        capHash,
        taskId: stored.taskId,
        paymentHash,
        amount: parseAmount(contract.payment.amount, precision),
        now,
        intentSha256: hashObj({ bolt11, paymentHash }),
      });
      // Exactly one caller pays a given hash: a concurrent call that lost the reservation race stops here (M4).
      if (!reserved.created) return { ok: true, status: "Pending", duplicate: true };
      ledger.recordLockBlocks(paymentHash, decoded.minFinalCltvExpiryDelta);
      this.d.tasks?.move(stored.taskId, "INVOICE_RECEIVED");
      try {
        // Never pay one hash twice: a wallet that already knows a payment for it answers instead of sending again.
        const known = await this.knownPayerStatus(paymentHash);
        if (known) {
          this.onStatus({ paymentHash, status: known, role: "payer" });
          return { ok: true, status: known, duplicate: true };
        }
        const sent = await wallet.pay(bolt11);
        this.onStatus({ paymentHash, status: sent.status, role: "payer" });
        return { ok: true, status: sent.status, duplicate: false };
      } catch (e) {
        if (e instanceof UnconfirmedPayment)
          return this.unconfirmed(paymentHash, stored.taskId, e.message);
        // Only a refusal that proves nothing was sent frees the budget. A timeout or lost connection may hide an
        // HTLC in flight, so the reservation stays until the wallet reports Failed (spec 7.2).
        const notSent =
          e instanceof WalletError &&
          (e.code === "WALLET_INVALID_INPUT" || e.code === "WALLET_AMOUNT_TOO_SMALL");
        if (notSent) {
          this.onStatus({ paymentHash, status: "Failed", role: "payer" });
          return block("MALFORMED_INTENT", {
            reason: `the payment was refused before it was sent (${e instanceof Error ? e.message : "wallet error"})`,
          });
        }
        return this.unconfirmed(
          paymentHash,
          stored.taskId,
          e instanceof Error ? e.message : "wallet error",
        );
      }
    } catch (e) {
      if (e instanceof BlockError) return { ok: false, code: e.code, message: e.userMessage };
      // Fail closed: any other error means nothing was reserved by this call or it is already released.
      return block("MALFORMED_INTENT", {
        reason: `the invoice could not be checked (${e instanceof Error ? e.message : "unknown error"})`,
      });
    }
  }

  /** The payer-side status the wallet already holds for this hash, undefined if it never saw one. */
  private async knownPayerStatus(
    paymentHash: string,
  ): Promise<"Pending" | "Claimable" | "Settled" | "Failed" | undefined> {
    try {
      const seen = await this.d.wallet.paymentStatus(paymentHash);
      return seen.find((e) => e.role === "payer")?.status;
    } catch (e) {
      // "Never seen" is the only answer that lets us pay. Anything else could hide an HTLC in flight.
      if (e instanceof WalletError && e.code === "WALLET_INVALID_INPUT") return undefined;
      throw new UnconfirmedPayment(
        `the wallet could not say whether this payment was already sent (${e instanceof Error ? e.message : "wallet error"})`,
      );
    }
  }

  /** The payment may or may not be in flight: keep the reservation and tell the UI it is being confirmed. */
  private unconfirmed(paymentHash: string, tid: string, why: string): Block {
    this.d.bus.publish(
      { type: "PAYMENT_CONFIRMING", data: { task_id: tid, payment_hash: paymentHash } },
      this.d.now(),
    );
    return block("MALFORMED_INTENT", {
      reason: `the payment is being confirmed (${why}); the budget stays held until the wallet reports the outcome`,
    });
  }

  /** Wallet events are the only thing that move a reservation (spec 7.2). Payee-side events are ignored. */
  onStatus(e: {
    paymentHash: string;
    status: "Pending" | "Claimable" | "Settled" | "Failed";
    role: string;
  }): void {
    if (e.role !== "payer") return;
    const { ledger, bus } = this.d;
    const res = ledger.applyPaymentStatus(e.paymentHash, e.status, this.d.now());
    if (!res) return;
    bus.publish(
      {
        type: "PAYMENT_STATUS",
        data: { task_id: res.taskId, payment_hash: e.paymentHash, status: e.status },
      },
      this.d.now(),
    );
    const tasks = this.d.tasks;
    if (e.status === "Pending") {
      tasks?.move(res.taskId, "ESCROW_LOCKED");
      void this.d
        .height?.()
        .then((h) => ledger.recordLockHeight(e.paymentHash, h))
        .catch(() => undefined);
    }
    if (e.status === "Settled") {
      tasks?.move(res.taskId, "CLAIMED");
      bus.publish({ type: "CLAIMED", data: { payment_hash: e.paymentHash } }, this.d.now());
    }
    if (e.status === "Failed") {
      tasks?.move(res.taskId, "EXPIRED");
      tasks?.move(res.taskId, "REFUNDED");
      bus.publish({ type: "REFUNDED", data: { payment_hash: e.paymentHash } }, this.d.now());
    }
  }

  /** Subscribe to the buyer daemon's payment events. Returns the unsubscribe function. */
  start(): () => void {
    return this.d.wallet.onPaymentStatus((e) => {
      try {
        this.onStatus(e);
      } catch {
        // An illegal move is ignored; the reservation stays as the ledger table allows.
      }
    });
  }
}
