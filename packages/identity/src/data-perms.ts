import { chmodSync, lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Files that hold secrets: seeds and key files, SQLite ledgers (the engine ledger holds P) with their wal/shm, registries. */
const SECRET_FILE = /(^|\/)keys\/|\.key$|\.seed$|\.sqlite(-wal|-shm)?$|registry\.json$/;
/** Managed by the regtest containers (other uids); the 0700 data dir above it is what protects it. */
/** Directories that must themselves be owner-only (the data dir root always is). */
const SECRET_DIRS = new Set(["keys", "ledger-archive", "verifier"]);
const SKIPPED_DIRS = new Set(["regtest"]);

export interface PermProblem {
  path: string;
  mode: string;
  want: string;
}

/**
 * L3: the data dir and everything below it that holds secrets must be owner-only: directories 0700, secret files 0600
 * (the engine ledger holds the preimage P, the key files hold seeds). Returns the problems; with `fix` it repairs them.
 */
export function auditDataDir(dir: string, opts: { fix?: boolean } = {}): PermProblem[] {
  const problems: PermProblem[] = [];
  const check = (path: string, isDir: boolean, mode: number): void => {
    const want = isDir ? 0o700 : 0o600;
    if ((mode & 0o777) === want) return;
    // Tighter than wanted (for example 0400) is fine; only group/other access or a missing owner bit is a problem.
    if ((mode & 0o077) === 0 && (mode & 0o600) === 0o600 && !isDir) return;
    problems.push({
      path,
      mode: (mode & 0o777).toString(8).padStart(4, "0"),
      want: want.toString(8).padStart(4, "0"),
    });
    if (opts.fix) {
      try {
        chmodSync(path, want);
      } catch {
        /* not ours to change: stays reported */
      }
    }
  };
  const walk = (path: string): void => {
    const st = lstatSync(path);
    if (st.isSymbolicLink()) {
      problems.push({ path, mode: "link", want: "no symlinks" });
      return;
    }
    if (st.isDirectory()) {
      if (SKIPPED_DIRS.has(path.slice(dir.length + 1))) return;
      if (path === dir || SECRET_DIRS.has(path.slice(dir.length + 1))) check(path, true, st.mode);
      let names: string[];
      try {
        names = readdirSync(path);
      } catch {
        problems.push({ path, mode: "unreadable", want: "owned by this user" });
        return;
      }
      for (const n of names) walk(join(path, n));
    } else if (st.isFile()) {
      if (SECRET_FILE.test(path.slice(dir.length + 1))) check(path, false, st.mode);
    }
  };
  walk(dir);
  return problems;
}
