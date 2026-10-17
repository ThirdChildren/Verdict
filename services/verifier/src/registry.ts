import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { TaskContract, VerdictRecord } from "@verdict/protocol";

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
