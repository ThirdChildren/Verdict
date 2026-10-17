import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { TaskContract, VerdictRecord } from "@verdict/protocol";

/** One check as the verifier saw it. Format-1 packages have no kind, weight or timing: those are null. */
export interface RunCheckV2 {
  id: string;
  kind: string | null;
  weight: number | null;
  required: boolean;
  status: "pass" | "fail";
  ms: number | null;
}

/**
 * Evidence about one run that is NOT in the signed VerdictRecord (that record is strict in the frozen protocol).
 * Additive and optional: older registry files and the UI schema keep working.
 */
export interface RunReportV2 {
  package_sha256: string;
  package_id: string | null;
  /** null for format-1 packages. */
  profile: string | null;
  score: number | null;
  min_score: number | null;
  checks: RunCheckV2[];
  duration_ms: number;
  sandbox: string;
  determinism: "match" | "mismatch" | "skipped";
  /** The worker's own exit code from DELIVER, kept as evidence. */
  self_check_exit_code: number;
  /** (self_check_exit_code === 0) === (outcome === "PASS"); a low rate flags drift between the worker's package copy and ours. */
  self_check_agrees: boolean;
}

/** What the UI verifier lane shows about one verification run. */
export interface RunReport {
  record: VerdictRecord;
  /** PASS means RELEASE; FAIL means WITHHOLD (a check failed, or the run could not finish: see `code`). */
  outcome: "PASS" | "FAIL";
  code: string | null;
  message: string;
  sandbox: string;
  /** Last lines of what verify.sh printed, one JSON line per check, plus the runner's own conclusion. */
  log_tail: string[];
  /** sha256 of verify.sh itself. The contract commits to the whole package by package_sha256. */
  verify_sh_sha256: string;
  seconds: number;
  v2?: RunReportV2;
}

export interface TaskEntry {
  task_id: string;
  payment_hash: string;
  contract: TaskContract;
  /** Ciphertext only. The plaintext preimage exists in memory only while it is checked or released. */
  sealed_preimage: string;
  package_sha256: string;
  reports: RunReport[];
  /** RELEASED once a PASS verdict was signed and the preimage was handed over. */
  released: boolean;
}

/** task_id -> entry, persisted as one JSON file written atomically. */
export class Registry {
  private readonly tasks = new Map<string, TaskEntry>();

  constructor(private readonly file: string | null) {
    if (file) {
      try {
        const raw = JSON.parse(readFileSync(file, "utf8")) as TaskEntry[];
        for (const t of raw) this.tasks.set(t.task_id, t);
      } catch {
        // first start
      }
    }
  }

  get(taskId: string): TaskEntry | undefined {
    return this.tasks.get(taskId);
  }
  list(): TaskEntry[] {
    return [...this.tasks.values()];
  }

  put(t: TaskEntry): void {
    this.tasks.set(t.task_id, t);
    this.save();
  }

  save(): void {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = join(dirname(this.file), `.registry.${process.pid}.tmp`);
    writeFileSync(tmp, JSON.stringify([...this.tasks.values()]), { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}
