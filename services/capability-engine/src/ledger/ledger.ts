import { closeSync, openSync } from "node:fs";
import {
  assertReservationTransition,
  type ChildCapability,
  formatAmount,
  type PaymentStatus,
  parseAmount,
  type ReservationState,
  type RootCapability,
  renderBlockMessage,
} from "@verdict/protocol";
import Database from "better-sqlite3";
import { BlockError } from "../policy/decision.js";

export type SqliteDb = InstanceType<typeof Database>;

export interface ReserveRequest {
  readonly capHash: string;
  readonly taskId: string;
  readonly paymentHash: string;
  /** minor units */
  readonly amount: bigint;
  readonly now: Date;
  /** Hash of the signed spend intent. The same intent never reserves twice: a repeat returns the first reservation. */
  readonly intentSha256?: string;
}

/** What the engine answered the first time it saw a signed intent (replayed verbatim on a repeat). */
export interface IntentResult {
  readonly status: number;
  readonly body: unknown;
}

/** Budget snapshot after a ledger transition (minor units). */
export interface BudgetUpdate {
  readonly capId: string;
  readonly capHash: string;
  readonly remaining: bigint;
  readonly reserved: bigint;
  readonly committed: bigint;
}

export interface OfferRecord {
  intentSha256: string;
  paymentHash: string;
  taskId: string;
  contract: unknown;
  preimageHex: string;
  sealedPreimage: string;
}

export interface Reservation {
  readonly id: number;
  readonly capHash: string;
  readonly rootHash: string;
  readonly taskId: string;
  readonly paymentHash: string;
  readonly amount: bigint;
  readonly state: ReservationState;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS capabilities (
  hash TEXT PRIMARY KEY, cap_id TEXT NOT NULL, root_hash TEXT NOT NULL, parent_hash TEXT,
  max_total TEXT NOT NULL, max_payments INTEGER, expires_at TEXT NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0, json TEXT NOT NULL, holder TEXT
);
CREATE TABLE IF NOT EXISTS reservations (
  id INTEGER PRIMARY KEY AUTOINCREMENT, cap_hash TEXT NOT NULL, root_hash TEXT NOT NULL,
  task_id TEXT NOT NULL, payment_hash TEXT NOT NULL UNIQUE, amount TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('reserved','committed','released')),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS intent_results (
  intent_sha256 TEXT PRIMARY KEY, status INTEGER NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS contracts (
  payment_hash TEXT PRIMARY KEY, task_id TEXT NOT NULL, json TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS accepted_intents (
  intent_sha256 TEXT PRIMARY KEY, cap_hash TEXT NOT NULL, signed_by TEXT NOT NULL, intent TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS offers (
  intent_sha256 TEXT PRIMARY KEY, payment_hash TEXT NOT NULL UNIQUE, task_id TEXT NOT NULL, contract TEXT NOT NULL,
  preimage_hex TEXT NOT NULL, sealed_preimage TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS verifier_events (
  payment_hash TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('P_CONFIRM','VERDICT')), attempt INTEGER NOT NULL,
  json TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (payment_hash, kind, attempt)
);
CREATE TABLE IF NOT EXISTS locks (
  payment_hash TEXT PRIMARY KEY, cltv_blocks INTEGER NOT NULL, locked_height INTEGER
);
CREATE INDEX IF NOT EXISTS reservations_cap ON reservations(cap_hash);
CREATE INDEX IF NOT EXISTS reservations_root ON reservations(root_hash);
`;

interface CapRow {
  hash: string;
  root_hash: string;
  max_total: string;
  max_payments: number | null;
  revoked: number;
  parent_hash: string | null;
  cap_id: string;
  holder: string | null;
}
interface ResRow {
  id: number;
  cap_hash: string;
  root_hash: string;
  task_id: string;
  payment_hash: string;
  amount: string;
  state: ReservationState;
}

const toReservation = (r: ResRow): Reservation => ({
  id: r.id,
  capHash: r.cap_hash,
  rootHash: r.root_hash,
  taskId: r.task_id,
  paymentHash: r.payment_hash,
  amount: BigInt(r.amount),
  state: r.state,
});

/**
 * Budget ledger. Amounts are stored as decimal TEXT of bigint minor units (never floats, never
 * SQLite integers: 18-digit sums can overflow 64 bits) and summed in JS.
 * Remaining = max_total - sum(reservations not released), for the cap AND its root.
 */
export class Ledger {
  constructor(
    private readonly db: SqliteDb,
    private readonly precision: number,
  ) {
    db.pragma("journal_mode = WAL");
    db.pragma("busy_timeout = 5000");
    db.exec(SCHEMA);
    const cols = db.prepare("PRAGMA table_info(capabilities)").all() as { name: string }[];
    if (!cols.some((c) => c.name === "holder"))
      db.exec("ALTER TABLE capabilities ADD COLUMN holder TEXT");
    // E21: when a capability was retired by a newer mandate (null = never retired by replacement). Safe on old databases.
    if (!cols.some((c) => c.name === "revoked_at"))
      db.exec("ALTER TABLE capabilities ADD COLUMN revoked_at TEXT");
    const rcols = db.prepare("PRAGMA table_info(reservations)").all() as { name: string }[];
    if (!rcols.some((c) => c.name === "intent_sha256")) {
      db.exec("ALTER TABLE reservations ADD COLUMN intent_sha256 TEXT");
    }
    db.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS reservations_intent ON reservations(intent_sha256) WHERE intent_sha256 IS NOT NULL",
    );
  }

  intentResult(sha: string): IntentResult | undefined {
    const r = this.db
      .prepare("SELECT status, body FROM intent_results WHERE intent_sha256 = ?")
      .get(sha) as { status: number; body: string } | undefined;
    return r ? { status: r.status, body: JSON.parse(r.body) as unknown } : undefined;
  }

  /** First answer wins: a second call for the same intent is ignored. */
  rememberIntentResult(sha: string, result: IntentResult, now: Date): void {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO intent_results (intent_sha256, status, body, created_at) VALUES (?,?,?,?)",
      )
      .run(sha, result.status, JSON.stringify(result.body), now.toISOString());
  }

  /** Stores the intent the engine accepted, so a later contract can be checked against it. First write wins. */
  recordAcceptedIntent(
    sha: string,
    capHash: string,
    intent: unknown,
    signedBy: string,
    now: Date,
  ): void {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO accepted_intents (intent_sha256, cap_hash, signed_by, intent, created_at) VALUES (?,?,?,?,?)",
      )
      .run(sha, capHash, signedBy, JSON.stringify(intent), now.toISOString());
  }

  getAcceptedIntent(
    sha: string,
  ): { capHash: string; signedBy: string; intent: unknown } | undefined {
    const r = this.db
      .prepare("SELECT cap_hash, signed_by, intent FROM accepted_intents WHERE intent_sha256 = ?")
      .get(sha) as { cap_hash: string; signed_by: string; intent: string } | undefined;
    return r
      ? { capHash: r.cap_hash, signedBy: r.signed_by, intent: JSON.parse(r.intent) as unknown }
      : undefined;
  }

  /**
   * The offer built for an accepted intent, with the preimage vault entry. P lives only here (invariant 6);
   * nothing returned by the HTTP API or the event bus carries it. One offer per intent.
   */
  recordOffer(o: OfferRecord, now: Date): void {
    this.db
      .prepare(
        "INSERT INTO offers (intent_sha256, payment_hash, task_id, contract, preimage_hex, sealed_preimage, created_at) VALUES (?,?,?,?,?,?,?)",
      )
      .run(
        o.intentSha256,
        o.paymentHash,
        o.taskId,
        JSON.stringify(o.contract),
        o.preimageHex,
        o.sealedPreimage,
        now.toISOString(),
      );
  }

  /** The accepted intent hash of a task (from its offer), or undefined. Never reads the preimage. */
  intentShaForTask(taskId: string): string | undefined {
    const r = this.db.prepare("SELECT intent_sha256 FROM offers WHERE task_id = ?").get(taskId) as
      | { intent_sha256: string }
      | undefined;
    return r?.intent_sha256;
  }

  getOfferByIntent(sha: string): Omit<OfferRecord, "preimageHex"> | undefined {
    const r = this.db
      .prepare(
        "SELECT intent_sha256, payment_hash, task_id, contract, sealed_preimage FROM offers WHERE intent_sha256 = ?",
      )
      .get(sha) as
      | {
          intent_sha256: string;
          payment_hash: string;
          task_id: string;
          contract: string;
          sealed_preimage: string;
        }
      | undefined;
    return r
      ? {
          intentSha256: r.intent_sha256,
          paymentHash: r.payment_hash,
          taskId: r.task_id,
          contract: JSON.parse(r.contract) as unknown,
          sealedPreimage: r.sealed_preimage,
        }
      : undefined;
  }

  /** Every offer the engine made, oldest first: task id and the offered contract body (no secrets). */
  listOffers(): { taskId: string; contract: unknown }[] {
    const rows = this.db.prepare("SELECT task_id, contract FROM offers ORDER BY rowid").all() as {
      task_id: string;
      contract: string;
    }[];
    return rows.map((r) => ({ taskId: r.task_id, contract: JSON.parse(r.contract) as unknown }));
  }

  /** The signed offer body for a payment hash (what the engine itself offered). */
  getOfferContract(paymentHash: string): unknown {
    const r = this.db
      .prepare("SELECT contract FROM offers WHERE payment_hash = ?")
      .get(paymentHash) as { contract: string } | undefined;
    return r ? (JSON.parse(r.contract) as unknown) : undefined;
  }

  /** Release path only (verdict RELEASE or principal APPROVE). Never log the result. */
  preimageFor(paymentHash: string): string | undefined {
    const r = this.db
      .prepare("SELECT preimage_hex FROM offers WHERE payment_hash = ?")
      .get(paymentHash) as { preimage_hex: string } | undefined;
    return r?.preimage_hex;
  }

  /** The ciphertext the verifier gets in P_DEPOSIT. Never the plaintext. */
  sealedPreimageFor(paymentHash: string): string | undefined {
    const r = this.db
      .prepare("SELECT sealed_preimage FROM offers WHERE payment_hash = ?")
      .get(paymentHash) as { sealed_preimage: string } | undefined;
    return r?.sealed_preimage;
  }

  /** The verifier said it holds the secret for this hash. Idempotent. */
  recordPConfirm(paymentHash: string, body: unknown, now: Date): void {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO verifier_events (payment_hash, kind, attempt, json, created_at) VALUES (?, 'P_CONFIRM', 0, ?, ?)",
      )
      .run(paymentHash, JSON.stringify(body), now.toISOString());
  }

  hasPConfirm(paymentHash: string): boolean {
    return (
      this.db
        .prepare("SELECT 1 FROM verifier_events WHERE payment_hash = ? AND kind = 'P_CONFIRM'")
        .get(paymentHash) !== undefined
    );
  }

  /** A signed verdict record the engine has checked. Returns false when this attempt was already recorded. */
  recordVerdict(paymentHash: string, attempt: number, record: unknown, now: Date): boolean {
    return (
      this.db
        .prepare(
          "INSERT OR IGNORE INTO verifier_events (payment_hash, kind, attempt, json, created_at) VALUES (?, 'VERDICT', ?, ?, ?)",
        )
        .run(paymentHash, attempt, JSON.stringify(record), now.toISOString()).changes > 0
    );
  }

  verdictsFor(paymentHash: string): unknown[] {
    return (
      this.db
        .prepare(
          "SELECT json FROM verifier_events WHERE payment_hash = ? AND kind = 'VERDICT' ORDER BY attempt",
        )
        .all(paymentHash) as { json: string }[]
    ).map((r) => JSON.parse(r.json) as unknown);
  }

  private budgetListener: ((u: BudgetUpdate) => void) | undefined;

  /** Called after every committed reserve/commit/release, for the capability and its root. */
  onBudgetUpdate(fn: (u: BudgetUpdate) => void): void {
    this.budgetListener = fn;
  }

  private sum(column: "cap_hash" | "root_hash", hash: string, state: ReservationState): bigint {
    const rows = this.db
      .prepare(`SELECT amount FROM reservations WHERE ${column} = ? AND state = ?`)
      .all(hash, state) as { amount: string }[];
    return rows.reduce((s, r) => s + BigInt(r.amount), 0n);
  }

  /** Current budget snapshot of one capability (a root is measured against all its reservations). */
  budget(hash: string): BudgetUpdate | undefined {
    const cap = this.getCap(hash);
    if (!cap) return undefined;
    const col = cap.root_hash === hash ? "root_hash" : "cap_hash";
    return {
      capId: cap.cap_id,
      capHash: hash,
      remaining: this.remaining(hash),
      reserved: this.sum(col, hash, "reserved"),
      committed: this.sum(col, hash, "committed"),
    };
  }

  private notify(capHash: string): void {
    if (!this.budgetListener) return;
    const cap = this.getCap(capHash);
    if (!cap) return;
    for (const h of new Set([capHash, cap.root_hash])) {
      const u = this.budget(h);
      if (u) this.budgetListener(u);
    }
  }

  /** The public id bound as holder of a capability (who may sign spend intents), if any. */
  holderOf(hash: string): string | undefined {
    return this.getCap(hash)?.holder ?? undefined;
  }

  static open(path: string, precision: number): Ledger {
    // The ledger holds the preimage P (accepted MVP limit, see ARCHITECTURE limits): create it owner-only (L3).
    if (path !== ":memory:" && path !== "") closeSync(openSync(path, "a", 0o600));
    return new Ledger(new Database(path), precision);
  }

  close(): void {
    this.db.close();
  }

  /** Register a verified capability. rootHash = hash of the root (itself for a root). Idempotent. */
  registerCapability(
    cap: RootCapability | ChildCapability,
    hash: string,
    rootHash?: string,
    holder?: string,
  ): void {
    const isRoot = cap.parent === null;
    this.db
      .prepare(
        `INSERT OR IGNORE INTO capabilities (hash, cap_id, root_hash, parent_hash, max_total, max_payments, expires_at, json, holder)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        hash,
        cap.cap_id,
        isRoot ? hash : (rootHash ?? cap.parent),
        cap.parent,
        parseAmount(cap.max_total, this.precision).toString(),
        "max_payments" in cap ? cap.max_payments : null,
        cap.expires_at,
        JSON.stringify(cap),
        holder ?? null,
      );
  }

  revoke(hash: string, now?: Date): void {
    this.db
      .prepare(
        "UPDATE capabilities SET revoked = 1, revoked_at = COALESCE(revoked_at, ?) WHERE hash = ?",
      )
      .run((now ?? new Date()).toISOString(), hash);
  }

  /** Runs `fn` in one immediate SQLite transaction (nested calls join it). Any throw rolls everything back. */
  inTransaction<T>(fn: () => T): T {
    return this.db.transaction(fn).immediate();
  }

  /**
   * E21: the newest mandate replaces every other live root. Retires each other root and each of its children
   * that has no reservation in `reserved` state; children with one in flight stay valid until their payment
   * settles (see applyPaymentStatus). Never inserts, deletes or moves a reservation. One transaction.
   * Returns the retired capability ids (root first, then its children) and the number of children kept.
   */
  retireOtherRoots(keepRoot: string, now: Date): { retired: string[]; inFlight: number } {
    return this.inTransaction(() => {
      const roots = this.db
        .prepare(
          "SELECT hash, cap_id FROM capabilities WHERE parent_hash IS NULL AND revoked = 0 AND hash != ? ORDER BY rowid",
        )
        .all(keepRoot) as { hash: string; cap_id: string }[];
      const retired: string[] = [];
      let inFlight = 0;
      for (const root of roots) {
        this.revoke(root.hash, now);
        retired.push(root.cap_id);
        const kids = this.db
          .prepare(
            "SELECT hash, cap_id FROM capabilities WHERE root_hash = ? AND parent_hash IS NOT NULL AND revoked = 0 ORDER BY rowid",
          )
          .all(root.hash) as { hash: string; cap_id: string }[];
        for (const kid of kids) {
          if (this.hasReservedReservation(kid.hash)) {
            inFlight += 1;
            continue;
          }
          this.revoke(kid.hash, now);
          retired.push(kid.cap_id);
        }
      }
      return { retired, inFlight };
    });
  }

  private hasReservedReservation(capHash: string): boolean {
    return (
      this.db
        .prepare("SELECT 1 FROM reservations WHERE cap_hash = ? AND state = 'reserved' LIMIT 1")
        .get(capHash) !== undefined
    );
  }

  /** Revokes a child whose root was retired once nothing of it is in flight any more. */
  private closeRetiredChild(capHash: string, now: Date): void {
    const cap = this.getCap(capHash);
    if (!cap || cap.parent_hash === null || cap.revoked === 1) return;
    if (!this.isRevoked(cap.root_hash) || this.hasReservedReservation(capHash)) return;
    this.revoke(capHash, now);
  }

  /** The capability's own revoked flag only (a child of a retired root can still be unflagged while in flight). */
  hasOwnRevokedFlag(hash: string): boolean {
    return this.getCap(hash)?.revoked === 1;
  }

  isRevoked(hash: string): boolean {
    // Revoked when its own flag OR its root's is set (a child kept alive for an in-flight payment may not start another).
    const r = this.getCap(hash);
    if (r === undefined || r.revoked === 1) return true;
    const root = r.root_hash === hash ? r : this.getCap(r.root_hash);
    return root === undefined || root.revoked === 1;
  }

  /** The stored capability JSON for a hash, or undefined. Caller must re-validate with Zod. */
  getCapability(hash: string): unknown {
    const r = this.db.prepare("SELECT json FROM capabilities WHERE hash = ?").get(hash) as
      | { json: string }
      | undefined;
    return r ? (JSON.parse(r.json) as unknown) : undefined;
  }

  /** Stored JSON of every ancestor of a capability (parent first, root last). Throws if the chain is broken. */
  ancestors(hash: string): unknown[] {
    const out: unknown[] = [];
    let cur = this.getCap(hash);
    const seen = new Set<string>([hash]);
    while (cur?.parent_hash) {
      const ph: string = cur.parent_hash;
      if (seen.has(ph)) throw new Error("capability chain loops");
      seen.add(ph);
      const next = this.getCap(ph);
      if (!next) throw new Error("capability chain is broken");
      out.push(this.getCapability(ph));
      cur = next;
    }
    return out;
  }

  /** Latest registered child capability hash that has a holder, or undefined. */
  latestChild(): string | undefined {
    const r = this.db
      .prepare(
        "SELECT hash FROM capabilities WHERE parent_hash IS NOT NULL AND holder IS NOT NULL AND revoked = 0 ORDER BY rowid DESC LIMIT 1",
      )
      .get() as { hash: string } | undefined;
    return r?.hash;
  }

  /** Latest registered root capability hash, or undefined. */
  latestRoot(): string | undefined {
    const r = this.db
      .prepare(
        "SELECT hash FROM capabilities WHERE parent_hash IS NULL AND revoked = 0 ORDER BY rowid DESC LIMIT 1",
      )
      .get() as { hash: string } | undefined;
    return r?.hash;
  }

  /** True when some root exists but every root has been retired. */
  hasRetiredRoot(): boolean {
    return (
      this.db
        .prepare("SELECT 1 FROM capabilities WHERE parent_hash IS NULL AND revoked = 1 LIMIT 1")
        .get() !== undefined
    );
  }

  /** The HTLC lock length in blocks the invoice asked for (min_final_cltv_expiry_delta). Idempotent. */
  recordLockBlocks(paymentHash: string, cltvBlocks: number): void {
    this.db
      .prepare("INSERT OR IGNORE INTO locks (payment_hash, cltv_blocks) VALUES (?, ?)")
      .run(paymentHash, cltvBlocks);
  }

  /** The chain height when the wallet first reported the HTLC locked. Written once. */
  recordLockHeight(paymentHash: string, height: number): void {
    this.db
      .prepare(
        "UPDATE locks SET locked_height = ? WHERE payment_hash = ? AND locked_height IS NULL",
      )
      .run(height, paymentHash);
  }

  /** Every payment the engine reserved for, with its lock facts when known. */
  listPayments(): {
    taskId: string;
    paymentHash: string;
    cltvBlocks: number | null;
    lockedHeight: number | null;
  }[] {
    const rows = this.db
      .prepare(
        `SELECT r.task_id, r.payment_hash, l.cltv_blocks, l.locked_height FROM reservations r
         LEFT JOIN locks l ON l.payment_hash = r.payment_hash ORDER BY r.id`,
      )
      .all() as {
      task_id: string;
      payment_hash: string;
      cltv_blocks: number | null;
      locked_height: number | null;
    }[];
    return rows.map((r) => ({
      taskId: r.task_id,
      paymentHash: r.payment_hash,
      cltvBlocks: r.cltv_blocks,
      lockedHeight: r.locked_height,
    }));
  }

  /** The stored contract JSON and payment hash for a task id. */
  getContractByTask(taskId: string): { paymentHash: string; contract: unknown } | undefined {
    const r = this.db
      .prepare("SELECT payment_hash, json FROM contracts WHERE task_id = ?")
      .get(taskId) as { payment_hash: string; json: string } | undefined;
    return r ? { paymentHash: r.payment_hash, contract: JSON.parse(r.json) as unknown } : undefined;
  }

  private getCap(hash: string): CapRow | undefined {
    return this.db.prepare("SELECT * FROM capabilities WHERE hash = ?").get(hash) as
      | CapRow
      | undefined;
  }

  private used(column: "cap_hash" | "root_hash", hash: string): bigint {
    const rows = this.db
      .prepare(`SELECT amount FROM reservations WHERE ${column} = ? AND state != 'released'`)
      .all(hash) as { amount: string }[];
    return rows.reduce((s, r) => s + BigInt(r.amount), 0n);
  }

  /** Budget left for this capability: min(own remaining, root remaining). Unknown cap -> 0n. */
  remaining(hash: string): bigint {
    const cap = this.getCap(hash);
    if (!cap) return 0n;
    const own = BigInt(cap.max_total) - this.used("cap_hash", hash);
    const root = this.getCap(cap.root_hash);
    if (!root) return 0n;
    const rootLeft = BigInt(root.max_total) - this.used("root_hash", cap.root_hash);
    const m = own < rootLeft ? own : rootLeft;
    return m < 0n ? 0n : m;
  }

  /** Remaining of a root capability only (what canDerive compares a child against). */
  rootRemaining(rootHash: string): bigint {
    return this.remaining(rootHash);
  }

  paymentsMade(hash: string): number {
    const r = this.db
      .prepare("SELECT COUNT(*) AS n FROM reservations WHERE cap_hash = ? AND state != 'released'")
      .get(hash) as { n: number };
    return r.n;
  }

  /**
   * Invariant 3: re-read remaining and insert the reservation in ONE immediate transaction
   * (write lock taken up front, so concurrent connections serialize). Throws BlockError if the
   * budget or payment count no longer allows it. Only after this returns may the wallet be called.
   */
  reserve(req: ReserveRequest): Reservation & { readonly created: boolean } {
    const tx = this.db.transaction((): Reservation & { readonly created: boolean } => {
      // An existing row for the same intent is returned, never duplicated (M4); the payment_hash UNIQUE constraint backs it.
      // `created: false` tells the caller that someone else already owns the payment.
      const prior = this.db
        .prepare("SELECT * FROM reservations WHERE intent_sha256 IS NOT NULL AND intent_sha256 = ?")
        .get(req.intentSha256 ?? null) as ResRow | undefined;
      if (prior) return { ...toReservation(prior), created: false };
      // Same hash under another intent falls through to the UNIQUE(payment_hash) constraint and throws.
      const cap = this.getCap(req.capHash);
      if (!cap) throw new BlockError("PARENT_MISMATCH", renderBlockMessage("PARENT_MISMATCH"));
      if (this.isRevoked(req.capHash))
        throw new BlockError("CAPABILITY_REVOKED", renderBlockMessage("CAPABILITY_REVOKED"));
      if (req.amount <= 0n)
        throw new BlockError(
          "MALFORMED_INTENT",
          renderBlockMessage("MALFORMED_INTENT", { reason: "amount must be positive" }),
        );
      const left = this.remaining(req.capHash);
      if (req.amount > left)
        throw new BlockError(
          "AMOUNT_EXCEEDS_REMAINING",
          renderBlockMessage("AMOUNT_EXCEEDS_REMAINING", {
            amount: formatAmount(req.amount, this.precision),
            remaining: formatAmount(left, this.precision),
          }),
        );
      if (cap.max_payments !== null && this.paymentsMade(req.capHash) >= cap.max_payments)
        throw new BlockError(
          "MAX_PAYMENTS_REACHED",
          renderBlockMessage("MAX_PAYMENTS_REACHED", { max: cap.max_payments }),
        );
      const ts = req.now.toISOString();
      const info = this.db
        .prepare(
          `INSERT INTO reservations (cap_hash, root_hash, task_id, payment_hash, amount, state, created_at, updated_at, intent_sha256)
           VALUES (?,?,?,?,?,'reserved',?,?,?)`,
        )
        .run(
          req.capHash,
          cap.root_hash,
          req.taskId,
          req.paymentHash,
          req.amount.toString(),
          ts,
          ts,
          req.intentSha256 ?? null,
        );
      return { ...(this.get(Number(info.lastInsertRowid)) as Reservation), created: true };
    });
    const r = tx.immediate();
    this.notify(req.capHash);
    return r;
  }

  /** Stores a signed task contract by its payment hash. Idempotent for the same contract; a different one under the same hash throws. */
  registerContract(paymentHash: string, taskId: string, contract: unknown, now: Date): void {
    const json = JSON.stringify(contract);
    const prior = this.db
      .prepare("SELECT json FROM contracts WHERE payment_hash = ?")
      .get(paymentHash) as { json: string } | undefined;
    if (prior) {
      if (prior.json !== json)
        throw new Error("A different contract already uses this payment hash");
      return;
    }
    this.db
      .prepare("INSERT INTO contracts (payment_hash, task_id, json, created_at) VALUES (?,?,?,?)")
      .run(paymentHash, taskId, json, now.toISOString());
  }

  /** The stored contract JSON (re-validate with Zod) and its task id. */
  getContract(paymentHash: string): { taskId: string; contract: unknown } | undefined {
    const r = this.db
      .prepare("SELECT task_id, json FROM contracts WHERE payment_hash = ?")
      .get(paymentHash) as { task_id: string; json: string } | undefined;
    return r ? { taskId: r.task_id, contract: JSON.parse(r.json) as unknown } : undefined;
  }

  get(id: number): Reservation | undefined {
    const r = this.db.prepare("SELECT * FROM reservations WHERE id = ?").get(id) as
      | ResRow
      | undefined;
    return r ? toReservation(r) : undefined;
  }

  getByPaymentHash(paymentHash: string): Reservation | undefined {
    const r = this.db
      .prepare("SELECT * FROM reservations WHERE payment_hash = ?")
      .get(paymentHash) as ResRow | undefined;
    return r ? toReservation(r) : undefined;
  }

  /** Moves a reservation along the protocol table; throws on an illegal move. */
  transition(id: number, to: ReservationState, now: Date): Reservation {
    const tx = this.db.transaction((): Reservation => {
      const cur = this.get(id);
      if (!cur) throw new Error(`Unknown reservation ${id}`);
      assertReservationTransition(cur.state, to);
      this.db
        .prepare("UPDATE reservations SET state = ?, updated_at = ? WHERE id = ?")
        .run(to, now.toISOString(), id);
      return this.get(id) as Reservation;
    });
    const r = tx.immediate();
    this.notify(r.capHash);
    return r;
  }

  /**
   * Wallet-event mapping (the only caller allowed to move reservations):
   * Settled -> committed; Failed -> released; Pending/Claimable -> unchanged (budget stays held as
   * 'reserved'; the protocol table has no committed -> released edge, see report).
   * Idempotent: replays of an already-applied status are ignored.
   */
  applyPaymentStatus(
    paymentHash: string,
    status: PaymentStatus,
    now: Date,
  ): Reservation | undefined {
    const cur = this.getByPaymentHash(paymentHash);
    if (!cur) return undefined;
    const target: ReservationState | null =
      status === "Settled" ? "committed" : status === "Failed" ? "released" : null;
    if (target === null) return cur;
    // One transaction: the move and the revocation of a retired child (E21) succeed or fail together.
    return this.inTransaction(() => {
      const res = cur.state === target ? cur : this.transition(cur.id, target, now);
      this.closeRetiredChild(cur.capHash, now);
      return res;
    });
  }
}
