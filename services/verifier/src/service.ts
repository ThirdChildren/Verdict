import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  contractHash,
  type Envelope,
  type EnvelopeType,
  hexToBytes,
  type MessageBody,
  openPreimage,
  type Signer,
  sha256Hex,
  signPayload,
  type TaskContract,
  taskId as taskIdOf,
  type VerdictRecord,
  verdictRecordSchema,
  verifyPayload,
} from "@verdict/protocol";
import { dirHashFromDisk } from "@verdict/protocol/node";
import { buildEnvelope, checkEnvelope } from "./envelope.js";
import { MAX_COMPRESSED_BYTES } from "./extract.js";
import type { Registry, RunReport, TaskEntry } from "./registry.js";
import { extractTarball, type RunOptions, type RunResult, runVerification } from "./runner.js";

/** A runner result; `code` also covers the checks the verifier makes before it runs anything. */
type Evaluated = Omit<RunResult, "code" | "sandbox"> & { code?: string; sandbox: string };

export type Answer = { ok: true; detail?: string } | { ok: false; code: string; message: string };

export interface VerifierDeps {
  signer: Signer;
  /** Ed25519 seed. Opens sealed preimages (converted to X25519) only while a check or a release needs it. */
  seed: Uint8Array;
  packageDir: string;
  registry: Registry;
  engineId: string;
  engineUrl: string;
  workerUrl: string;
  now?: () => Date;
  fetchImpl?: typeof fetch;
  /** Test seam; production uses the sandboxed runner. */
  run?: (o: RunOptions) => Promise<RunResult>;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
  /** Gaps between PREIMAGE delivery attempts, ms. */
  preimageRetryMs?: number[];
  /** Deliveries per task. 1 for the MVP: every verdict is final, there is no redelivery after FAIL or WITHHOLD (M5). */
  maxDeliveries?: number;
}

const refuse = (code: string, message: string): Answer => ({ ok: false, code, message });
const sha256File = (p: string): string =>
  createHash("sha256").update(readFileSync(p)).digest("hex");

/**
 * The verifier (ARCHITECTURE section 9). It holds no wallet and no seed except its own Ed25519 identity. It opens the sealed
 * preimage only to check it at deposit and to release it after a signed RELEASE verdict. A failed or unfinished
 * verification never opens it. Verdicts are decided by the verifier package's exit code, never by a model.
 */
export class VerifierService {
  private chain: Promise<unknown> = Promise.resolve();
  private readonly seen = new Set<string>();

  constructor(private readonly d: VerifierDeps) {}

  private now(): Date {
    return (this.d.now ?? (() => new Date()))();
  }
  private log(msg: string, extra?: Record<string, unknown>): void {
    this.d.log?.(msg, extra);
  }

  /** Resolves when every queued verification and release has finished. */
  idle(): Promise<void> {
    return this.chain.then(
      () => undefined,
      () => undefined,
    );
  }

  async handle(env: Envelope): Promise<Answer> {
    const problem = await checkEnvelope(env, this.d.signer.publicId, this.now());
    if (problem) return refuse("SIGNATURE_INVALID", problem);
    if (this.seen.has(env.id)) return refuse("MALFORMED_INTENT", "duplicate message id");
    this.seen.add(env.id);
    if (this.seen.size > 5000) this.seen.clear();
    switch (env.type) {
      case "P_DEPOSIT":
        return this.deposit(env);
      case "DELIVER":
        return this.deliver(env);
      case "ESCROW_LOCKED":
      case "CLAIMED":
        this.log(`${env.type} received`, { task: env.task_id });
        return { ok: true };
      default:
        return refuse("MALFORMED_INTENT", `${env.type} is not handled by the verifier`);
    }
  }

  private async contractOk(c: TaskContract): Promise<boolean> {
    const body = c as unknown as Record<string, unknown>;
    return (
      (await verifyPayload("TASK_CONTRACT", body, c.buyer, c.signatures.buyer)) &&
      (await verifyPayload("TASK_CONTRACT", body, c.worker, c.signatures.worker))
    );
  }

  /** P_DEPOSIT: check both signatures, sha256(P) == H and the local package hash, then P_CONFIRM to worker and engine. */
  private async deposit(env: Extract<Envelope, { type: "P_DEPOSIT" }>): Promise<Answer> {
    const { contract, sealed_preimage } = env.body;
    if (env.from !== this.d.engineId || contract.buyer !== this.d.engineId)
      return refuse("SIGNATURE_INVALID", "the deposit is not from the buyer this verifier serves");
    if (contract.verifier.public_id !== this.d.signer.publicId)
      return refuse("SIGNATURE_INVALID", "the contract names a different verifier");
    const tid = taskIdOf(contract);
    if (env.task_id !== tid)
      return refuse("MALFORMED_INTENT", "task id does not match the contract");
    if (!(await this.contractOk(contract)))
      return refuse("SIGNATURE_INVALID", "a contract signature is invalid");
    const existing = this.d.registry.get(tid);
    if (existing) {
      await this.confirm(existing);
      return { ok: true, detail: "already deposited" };
    }
    let packageSha: string;
    try {
      packageSha = await dirHashFromDisk(this.d.packageDir);
    } catch (e) {
      return refuse(
        "PACKAGE_HASH_MISMATCH",
        `the local verifier package is unreadable (${(e as Error).message})`,
      );
    }
    if (packageSha !== contract.verifier.package_sha256)
      return refuse(
        "PACKAGE_HASH_MISMATCH",
        "the verifier package on this machine is not the one the contract names",
      );
    try {
      const p = await openPreimage(sealed_preimage, this.d.seed);
      if (sha256Hex(hexToBytes(p)) !== contract.payment.payment_hash)
        return refuse("PREIMAGE_MISMATCH", "the sealed secret does not match the payment hash");
    } catch {
      return refuse("PREIMAGE_MISMATCH", "the sealed secret could not be opened");
    }
    const entry: TaskEntry = {
      task_id: tid,
      payment_hash: contract.payment.payment_hash,
      contract,
      sealed_preimage,
      package_sha256: packageSha,
      reports: [],
      released: false,
    };
    this.d.registry.put(entry);
    await this.confirm(entry);
    this.log("deposit confirmed", { task: tid });
    return { ok: true };
  }

  private async confirm(t: TaskEntry): Promise<void> {
    const body: MessageBody<"P_CONFIRM"> = {
      task_id: t.task_id,
      payment_hash: t.payment_hash,
      package_sha256: t.package_sha256,
      confirmed: true,
    };
    await Promise.all([
      this.send(this.d.workerUrl, "P_CONFIRM", t.task_id, t.contract.worker, body),
      this.send(this.d.engineUrl, "P_CONFIRM", t.task_id, this.d.engineId, body),
    ]);
  }

  private async deliver(env: Extract<Envelope, { type: "DELIVER" }>): Promise<Answer> {
    const t = this.d.registry.get(env.task_id);
    if (!t) return refuse("MALFORMED_INTENT", "no deposit for this task");
    if (env.from !== t.contract.worker)
      return refuse("SIGNATURE_INVALID", "the delivery is not from the contract's worker");
    if (t.released) return refuse("MALFORMED_INTENT", "this task was already paid out");
    if (this.now().getTime() > Date.parse(t.contract.task.deadline))
      return refuse("DEADLINE_PASSED", "the deadline has passed; no more deliveries are accepted");
    if (t.reports.length >= (this.d.maxDeliveries ?? 1))
      return refuse("DELIVERY_REJECTED", "too many deliveries for this task");
    const { attempt, delivery_sha256, bundle_b64 } = env.body;
    this.chain = this.chain
      .catch(() => undefined)
      .then(() => this.verify(t, attempt, delivery_sha256, bundle_b64));
    return { ok: true, detail: "queued" };
  }

  /** The checks and the sandboxed run for one delivery. Never throws: anything unexpected is a WITHHOLD result. */
  private async evaluate(t: TaskEntry, announced: string, bundleB64: string): Promise<Evaluated> {
    const c = t.contract;
    const withhold = (code: string, message: string, sandbox = "not run"): Evaluated => ({
      outcome: "WITHHOLD",
      code,
      message,
      exitCode: null,
      checks: [],
      sandbox,
    });
    const tmp = mkdtempSync(join(tmpdir(), "verifier-delivery-"));
    try {
      const dest = join(tmp, "delivery");
      mkdirSync(dest);
      const tarball = join(tmp, "bundle.tar.gz");
      if (bundleB64.length > Math.ceil((MAX_COMPRESSED_BYTES * 4) / 3) + 8)
        return withhold(
          "DELIVERY_REJECTED",
          "Delivery rejected: Bundle larger than 1 MB compressed",
        );
      writeFileSync(tarball, Buffer.from(bundleB64, "base64"));
      const packageOk = await dirHashFromDisk(this.d.packageDir).then(
        (h) => h === c.verifier.package_sha256,
        () => false,
      );
      if (!packageOk)
        return withhold(
          "PACKAGE_HASH_MISMATCH",
          "The verifier package no longer matches the contract.",
        );
      try {
        extractTarball(tarball, dest);
      } catch (e) {
        return withhold("DELIVERY_REJECTED", `Delivery rejected: ${(e as Error).message}`);
      }
      const actual = await dirHashFromDisk(dest).catch(() => "");
      if (actual !== announced)
        return withhold(
          "DELIVERY_HASH_MISMATCH",
          "The delivery does not match the hash the worker announced.",
        );
      return await (this.d.run ?? runVerification)({
        packageDir: this.d.packageDir,
        deliveryDir: dest,
        maxVerifySeconds: c.task.max_verify_seconds,
        expectedDeliverySha256: announced,
        ...(this.d.log ? { log: (m: string) => this.log(m) } : {}),
      });
    } catch (e) {
      return withhold(
        "RUNNER_ERROR",
        `Verification could not finish (${(e as Error).message})`,
        "unknown",
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  /** Runs one delivery and always ends in a signed verdict (invariant 7: anything unexpected is WITHHOLD). */
  private async verify(
    t: TaskEntry,
    attempt: number,
    announced: string,
    bundleB64: string,
  ): Promise<void> {
    const c = t.contract;
    const started = Date.now();
    const r = await this.evaluate(t, announced, bundleB64);
    const release = r.outcome === "PASS";
    const unsigned = {
      task_id: t.task_id,
      contract_sha256: contractHash(c as unknown as Record<string, unknown>),
      delivery_sha256: announced,
      verifier_package_sha256: c.verifier.package_sha256,
      attempt,
      checks: r.checks.map((k) => ({
        id: k.id,
        status: k.status === "pass" ? ("PASS" as const) : ("FAIL" as const),
      })),
      exit_code: r.exitCode ?? -1,
      verdict: release ? ("RELEASE" as const) : ("WITHHOLD" as const),
      payment_hash: t.payment_hash,
      timestamp: Math.floor(this.now().getTime() / 1000),
    };
    const record: VerdictRecord = verdictRecordSchema.parse({
      ...unsigned,
      verifier_sig: await signPayload(this.d.signer, "VERDICT", unsigned),
    });
    const report: RunReport = {
      record,
      outcome: release ? "PASS" : "FAIL",
      code: "code" in r && r.code ? r.code : null,
      message: r.message,
      sandbox: r.sandbox,
      log_tail: [
        ...r.checks.map((k) => JSON.stringify({ id: k.id, status: k.status })),
        `exit ${r.exitCode ?? "none"}: ${r.message}`,
      ].slice(-20),
      verify_sh_sha256: (() => {
        try {
          return sha256File(join(this.d.packageDir, "verify.sh"));
        } catch {
          return "unreadable";
        }
      })(),
      seconds: Number(((Date.now() - started) / 1000).toFixed(1)),
    };
    t.reports.push(report);
    if (release) t.released = true;
    this.d.registry.put(t);
    this.log("verdict", { task: t.task_id, attempt, verdict: record.verdict, code: report.code });

    await Promise.all([
      this.send(this.d.engineUrl, "VERDICT", t.task_id, this.d.engineId, record),
      this.send(this.d.workerUrl, "VERDICT", t.task_id, c.worker, record),
    ]);
    if (release) await this.release(t);
  }

  /** Opens P only now, after a signed RELEASE, and hands it to the worker. P is never logged. */
  private async release(t: TaskEntry): Promise<void> {
    const preimage_hex = await openPreimage(t.sealed_preimage, this.d.seed);
    const body: MessageBody<"PREIMAGE"> = {
      payment_hash: t.payment_hash,
      preimage_hex,
      reason: "VERDICT_RELEASE",
    };
    const gaps = this.d.preimageRetryMs ?? [0, 2000, 4000, 8000, 16000];
    for (const gap of gaps) {
      if (gap > 0) await new Promise((r) => setTimeout(r, gap));
      if (await this.send(this.d.workerUrl, "PREIMAGE", t.task_id, t.contract.worker, body)) {
        this.log("preimage released to the worker", { task: t.task_id });
        return;
      }
    }
    this.log("PREIMAGE could not be delivered; the worker can still ask the principal to approve", {
      task: t.task_id,
    });
  }

  private async send<T extends EnvelopeType>(
    baseUrl: string,
    type: T,
    tid: string,
    to: string,
    body: MessageBody<T>,
  ): Promise<boolean> {
    try {
      const env = await buildEnvelope(this.d.signer, type, tid, to, body, this.now());
      const r = await (this.d.fetchImpl ?? fetch)(`${baseUrl}/v0/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(env),
        signal: AbortSignal.timeout(15_000),
      });
      if (!r.ok) this.log(`${type} to ${to.slice(0, 14)}… refused`, { status: r.status });
      return r.ok;
    } catch (e) {
      this.log(`${type} could not be sent`, { error: (e as Error).message });
      return false;
    }
  }

  reports(): { task_id: string; payment_hash: string; released: boolean; reports: RunReport[] }[] {
    return this.d.registry.list().map((t) => ({
      task_id: t.task_id,
      payment_hash: t.payment_hash,
      released: t.released,
      reports: t.reports,
    }));
  }
}
