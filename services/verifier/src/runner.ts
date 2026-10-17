// Sandboxed runner (ARCHITECTURE section 9). Executor and judge are separate (H1):
//  - the EXECUTOR runs the delivery once per case inside the sandbox (bwrap on Linux, sandbox-exec on macOS) with the
//    delivery and the case inputs read-only, ONE writable scratch dir (size-limited tmpfs), no network, no pid/ipc view,
//    resource limits (memory, tasks, cpu, file size). Its stdout is the only result channel: the runner opens the output
//    file and the child inherits it, so the delivery cannot touch other outputs;
//  - the JUDGE (the package's verify.mjs) runs outside the sandbox in a process that never loads delivery code and reads
//    the outputs as size-limited data. Expected files exist only in the package, which the delivery never sees.
// The package is hashed before and after the run. Fail closed: anything unexpected is WITHHOLD, never PASS.
// There is no way to run without the sandbox: if it is unavailable, nothing is executed.
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { resolveDataDir } from "@verdict/identity";
import { dirHashFromDisk } from "@verdict/protocol/node";
import { MAX_DELIVERY_BYTES } from "./extract.js";

export { extractTarball, MAX_DELIVERY_BYTES } from "./extract.js";

export type SandboxKind = "bwrap" | "sandbox-exec";
export type Outcome = "PASS" | "FAIL" | "WITHHOLD";
export type RunnerCode =
  | "DELIVERY_HASH_MISMATCH"
  | "DELIVERY_REJECTED"
  | "SANDBOX_UNAVAILABLE"
  | "PACKAGE_TAMPERED"
  | "PACKAGE_INVALID"
  | "VERIFY_TIMEOUT"
  | "VERIFY_CRASH"
  | "VERIFY_OUTPUT_INVALID"
  | "RUNNER_ERROR";

export interface Check {
  id: string;
  status: "pass" | "fail";
}

export interface RunResult {
  outcome: Outcome;
  exitCode: number | null;
  checks: Check[];
  sandbox: SandboxKind | "unavailable";
  code?: RunnerCode;
  message: string;
}

export interface RunOptions {
  packageDir: string;
  deliveryDir: string;
  /** Wall-clock budget for the whole run (all cases plus the judge). */
  maxVerifySeconds: number;
  /** If set, the delivery dir hash must equal this (hex). */
  expectedDeliverySha256?: string;
  log?: (msg: string) => void;
}

/** What the package tells the runner (manifest.json is part of the content-hashed package). */
interface Manifest {
  entry: string;
  cases_dir: string;
  input_ext: string;
  output_ext: string;
  case_timeout_seconds: number;
  max_output_bytes: number;
}

const MAX_STDOUT_BYTES = 64 * 1024;
const LIMIT_AS_BYTES = 2 * 1024 ** 3;
const LIMIT_EXTRA_TASKS = 128;
const SCRATCH_BYTES = 8 * 1024 * 1024;
const SANDBOX_PROFILE_NET = "(version 1)(allow default)(deny network*)";

function probe(cmd: string, args: string[]): boolean {
  try {
    return spawnSync(cmd, args, { stdio: "ignore", timeout: 5000 }).status === 0;
  } catch {
    return false;
  }
}

/** The sandbox this machine can really use, or null. Probed by running it, never assumed. */
export function detectSandbox(): SandboxKind | null {
  if (process.platform === "linux") {
    return probe("bwrap", ["--unshare-all", ...systemBinds(), "--", "/usr/bin/true"]) &&
      probe("prlimit", ["--nproc=100000", "--", "/usr/bin/true"])
      ? "bwrap"
      : null;
  }
  if (process.platform === "darwin") {
    return probe("sandbox-exec", ["-p", SANDBOX_PROFILE_NET, "/usr/bin/true"])
      ? "sandbox-exec"
      : null;
  }
  return null;
}

/** For service start-up: throws a plain-language error if no sandbox is usable (M3, no escape hatch). */
export function requireSandbox(): SandboxKind {
  const k = detectSandbox();
  if (k === null)
    throw new Error(
      "No usable sandbox on this machine (needs bubblewrap and prlimit on Linux, or sandbox-exec on macOS). The verifier will not run deliveries without one.",
    );
  return k;
}

/** Number of tasks (threads) the current user already runs; the nproc limit is set above it, because RLIMIT_NPROC counts per uid. */
function currentTaskCount(): number {
  try {
    const uid = process.getuid?.();
    let n = 0;
    for (const pid of readdirSync("/proc")) {
      if (!/^\d+$/.test(pid)) continue;
      try {
        if (lstatSync(`/proc/${pid}`).uid !== uid) continue;
        n += readdirSync(`/proc/${pid}/task`).length;
      } catch {
        /* process gone */
      }
    }
    return n;
  } catch {
    return 4096;
  }
}

/** Processes the current user already runs on macOS; RLIMIT_NPROC counts per uid there too. */
function currentProcessCountDarwin(): number {
  const r = spawnSync("ps", ["-U", String(process.getuid?.() ?? 0), "-o", "pid="], {
    encoding: "utf8",
  });
  return r.status === 0 ? r.stdout.split("\n").filter((l) => l.trim()).length : 1024;
}

/** Read-only system directories (symlinks such as /bin -> usr/bin are recreated), and nothing else of the host. */
function systemBinds(): string[] {
  return ["/usr", "/lib", "/lib64", "/bin", "/sbin"]
    .filter((p) => existsSync(p))
    .flatMap((p) =>
      lstatSync(p).isSymbolicLink() ? ["--symlink", readlinkSync(p), p] : ["--ro-bind", p, p],
    );
}

interface Mounts {
  delivery: string;
  inputs: string;
  /** The one writable directory the delivery sees (a size-limited tmpfs on Linux). Its results are NOT read back. */
  scratch: string;
  /** Host paths the delivery must never read (package, verifier data dir). Enforced on macOS; on Linux they are not mounted. */
  hide?: string[];
}

/** argv that runs `node <entry> <input>` with stdout going to the inherited fd, inside the sandbox. */
export function sandboxArgv(
  kind: SandboxKind,
  m: Mounts,
  entry: string,
  input: string,
  limits: { cpuSeconds: number; fsizeBytes: number },
): [string, string[]] {
  const node = realpathSync(process.execPath);
  const lim = [
    `--as=${LIMIT_AS_BYTES}`,
    `--nproc=${currentTaskCount() + LIMIT_EXTRA_TASKS}`,
    `--cpu=${limits.cpuSeconds}`,
    `--fsize=${limits.fsizeBytes}`,
    "--core=0",
    "--nofile=64",
  ];
  if (kind === "bwrap") {
    const nodeRoot = dirname(dirname(node));
    const binds = systemBinds();
    return [
      "bwrap",
      [
        "--die-with-parent",
        "--new-session",
        "--unshare-all",
        "--clearenv",
        "--setenv",
        "PATH",
        "/usr/bin:/bin",
        "--setenv",
        "HOME",
        "/out",
        "--setenv",
        "LANG",
        "C",
        ...binds,
        ...(existsSync("/etc/ld.so.cache")
          ? ["--ro-bind", "/etc/ld.so.cache", "/etc/ld.so.cache"]
          : []),
        "--ro-bind",
        nodeRoot,
        nodeRoot,
        "--proc",
        "/proc",
        "--dev",
        "/dev",
        "--ro-bind",
        m.delivery,
        "/delivery",
        "--ro-bind",
        m.inputs,
        "/inputs",
        "--size",
        String(SCRATCH_BYTES),
        "--tmpfs",
        "/out",
        "--remount-ro",
        "/",
        "--chdir",
        "/out",
        "--",
        "prlimit",
        ...lim,
        "--",
        node,
        `/delivery/${entry}`,
        `/inputs/${input}`,
      ],
    ];
  }
  // macOS: Seatbelt profile. No network; writes only under scratch; reads are denied for the run's temp dir (which holds
  // the package copy with the expected files), the package, and the verifier's data dir, then re-allowed for the
  // delivery, the inputs and scratch only (the last matching rule wins). [Not run on a Mac yet.]
  const q = (p: string): string => JSON.stringify(p);
  const hidden = [dirname(m.delivery), ...(m.hide ?? [])];
  const profile = `(version 1)(allow default)(deny network*)(deny file-write*)(allow file-write* (subpath ${q(m.scratch)})(literal "/dev/null"))(deny file-read* ${hidden
    .map((p) => `(subpath ${q(p)})`)
    .join(
      "",
    )})(allow file-read* (subpath ${q(m.delivery)})(subpath ${q(m.inputs)})(subpath ${q(m.scratch)}))`;
  return [
    "sandbox-exec",
    [
      "-p",
      profile,
      "/bin/sh",
      "-c",
      `ulimit -c 0 -n 64 -u ${currentProcessCountDarwin() + 128} -t ${limits.cpuSeconds} -f ${Math.ceil(limits.fsizeBytes / 512)}; exec "$0" "$@"`,
      node,
      join(m.delivery, entry),
      join(m.inputs, input),
    ],
  ];
}

/** The path and its resolved form (macOS Seatbelt matches resolved paths, and /var is a symlink to /private/var). */
function realDirs(p: string): string[] {
  try {
    const r = realpathSync(p);
    return r === p ? [p] : [p, r];
  } catch {
    return [p];
  }
}

/** Validates a delivery directory: no symlinks, no special files, no escaping names, <= 1 MB total. */
export function validateDeliveryDir(root: string): void {
  let total = 0;
  const walk = (abs: string, rel: string): void => {
    for (const name of readdirSync(abs)) {
      const r = rel === "" ? name : `${rel}/${name}`;
      if (name === ".." || name.includes("\0") || isAbsolute(name) || name.includes("\\")) {
        throw new Error(`Illegal path: ${r}`);
      }
      const st = lstatSync(join(abs, name));
      if (st.isSymbolicLink()) throw new Error(`Symlink not allowed: ${r}`);
      if (st.isDirectory()) walk(join(abs, name), r);
      else if (st.isFile()) {
        if (st.nlink > 1) throw new Error(`Hardlink not allowed: ${r}`);
        total += st.size;
        if (total > MAX_DELIVERY_BYTES) throw new Error("Delivery larger than 1 MB");
      } else throw new Error(`Unsupported file type: ${r}`);
    }
  };
  walk(root, "");
}

function parseChecks(stdout: string): Check[] | null {
  const lines = stdout.split("\n").filter((l) => l.trim() !== "");
  if (lines.length === 0) return null;
  const out: Check[] = [];
  for (const l of lines) {
    try {
      const v: unknown = JSON.parse(l);
      if (typeof v !== "object" || v === null) return null;
      const { id, status } = v as Record<string, unknown>;
      if (typeof id !== "string" || (status !== "pass" && status !== "fail")) return null;
      out.push({ id, status });
    } catch {
      return null;
    }
  }
  return out;
}

function makeWritable(dir: string): void {
  try {
    chmodSync(dir, 0o755);
    for (const n of readdirSync(dir)) {
      const p = join(dir, n);
      if (lstatSync(p).isDirectory()) makeWritable(p);
    }
  } catch {
    /* best effort */
  }
}

function killGroup(child: ChildProcess): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    /* already gone */
  }
}

interface ProcResult {
  code: number | null;
  stdout: string;
  timedOut: boolean;
  overflow: boolean;
}

/** Runs one child in its own process group; the whole group is killed on timeout, overflow or exit. */
function runChild(
  cmd: string,
  args: string[],
  opts: { cwd: string; env: Record<string, string>; stdoutFd: number | "pipe"; timeoutMs: number },
): Promise<ProcResult> {
  return new Promise((resolveP, rejectP) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env,
      detached: true,
      stdio: ["ignore", opts.stdoutFd, "ignore"],
    });
    let stdout = "";
    let timedOut = false;
    let overflow = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child);
    }, opts.timeoutMs);
    child.stdout?.on("data", (b: Buffer) => {
      stdout += b.toString("utf8");
      if (stdout.length > MAX_STDOUT_BYTES) {
        overflow = true;
        killGroup(child);
      }
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      rejectP(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      killGroup(child); // reap stragglers left behind in the group
      resolveP({ code, stdout, timedOut, overflow });
    });
  });
}

function readManifest(pkg: string): Manifest {
  const m = JSON.parse(readFileSync(join(pkg, "manifest.json"), "utf8")) as Partial<Manifest>;
  const okStr = (v: unknown): v is string => typeof v === "string" && v !== "" && !v.includes("/");
  if (
    !okStr(m.entry) ||
    !okStr(m.cases_dir) ||
    !okStr(m.input_ext) ||
    !okStr(m.output_ext) ||
    typeof m.case_timeout_seconds !== "number" ||
    typeof m.max_output_bytes !== "number"
  )
    throw new Error("manifest.json is invalid");
  return m as Manifest;
}

/** Read-only copy of the package: the judge and the expected files the delivery can never reach. */
function lockTree(p: string): void {
  for (const n of readdirSync(p)) {
    const f = join(p, n);
    if (lstatSync(f).isDirectory()) lockTree(f);
    else chmodSync(f, n.endsWith(".sh") ? 0o555 : 0o444);
  }
  chmodSync(p, 0o555);
}

export async function runVerification(opts: RunOptions): Promise<RunResult> {
  const log = opts.log ?? (() => {});
  const deadline = Date.now() + opts.maxVerifySeconds * 1000;
  const withhold = (
    code: RunnerCode,
    message: string,
    sandbox: RunResult["sandbox"],
    exitCode: number | null = null,
    checks: Check[] = [],
  ): RunResult => ({ outcome: "WITHHOLD", code, message, sandbox, exitCode, checks });

  let sandbox: RunResult["sandbox"] = "unavailable";
  let tmp: string | undefined;
  try {
    const kind = detectSandbox();
    log(`verifier runner sandbox=${kind ?? "none"} platform=${process.platform}`);
    if (kind === null) {
      return withhold(
        "SANDBOX_UNAVAILABLE",
        "No sandbox is available on this machine, so the delivery was not run.",
        sandbox,
      );
    }
    sandbox = kind;

    if (opts.expectedDeliverySha256 !== undefined) {
      const h = await dirHashFromDisk(opts.deliveryDir);
      if (h !== opts.expectedDeliverySha256) {
        return withhold(
          "DELIVERY_HASH_MISMATCH",
          "The delivery does not match the committed hash.",
          sandbox,
        );
      }
    }
    try {
      validateDeliveryDir(opts.deliveryDir);
    } catch (e) {
      return withhold("DELIVERY_REJECTED", `Delivery rejected: ${(e as Error).message}`, sandbox);
    }

    const pkgBefore = await dirHashFromDisk(opts.packageDir);
    tmp = mkdtempSync(join(realpathSync(tmpdir()), "verdict-run-"));
    chmodSync(tmp, 0o700);
    const pkg = join(tmp, "package");
    const del = join(tmp, "delivery");
    const inputs = join(tmp, "inputs");
    const out = join(tmp, "out");
    cpSync(opts.packageDir, pkg, { recursive: true, dereference: false });
    cpSync(opts.deliveryDir, del, { recursive: true, dereference: false });
    mkdirSync(inputs);
    const scratch = join(tmp, "scratch");
    mkdirSync(out, { mode: 0o700 });
    mkdirSync(scratch, { mode: 0o777 });
    chmodSync(scratch, 0o777);
    let manifest: Manifest;
    try {
      manifest = readManifest(pkg);
    } catch (e) {
      return withhold(
        "PACKAGE_INVALID",
        `Verifier package unusable: ${(e as Error).message}`,
        sandbox,
      );
    }
    const names = readdirSync(join(pkg, manifest.cases_dir))
      .filter((f) => f.endsWith(manifest.input_ext))
      .sort();
    if (names.length === 0)
      return withhold("PACKAGE_INVALID", "The package has no cases.", sandbox);
    for (const f of names) cpSync(join(pkg, manifest.cases_dir, f), join(inputs, f));
    lockTree(pkg);
    lockTree(inputs);
    lockTree(del);
    const copyHash = await dirHashFromDisk(pkg);
    if (copyHash !== pkgBefore)
      return withhold("PACKAGE_TAMPERED", "The package changed while it was copied.", sandbox);

    // ---- executor: delivery code runs here, and only here ----
    // Each case gets an equal share of 80% of the budget, so a hanging delivery fails its cases instead of starving the judge.
    const perCaseMs = Math.max(
      1000,
      Math.min(manifest.case_timeout_seconds * 1000, (opts.maxVerifySeconds * 800) / names.length),
    );
    for (const f of names) {
      if (deadline - Date.now() <= 0)
        return withhold("VERIFY_TIMEOUT", "Verification timed out.", sandbox);
      const stem = f.slice(0, -manifest.input_ext.length);
      const outFile = join(out, `${stem}${manifest.output_ext}`);
      const fd = openSync(outFile, "w", 0o600);
      let res: ProcResult;
      try {
        const [cmd, args] = sandboxArgv(
          kind,
          {
            delivery: del,
            inputs,
            scratch,
            hide: [realpathSync(opts.packageDir), ...realDirs(resolveDataDir())],
          },
          manifest.entry,
          f,
          {
            cpuSeconds: Math.ceil(perCaseMs / 1000),
            fsizeBytes: manifest.max_output_bytes,
          },
        );
        res = await runChild(cmd, args, {
          cwd: tmp,
          env: { PATH: "/usr/bin:/bin", LANG: "C" },
          stdoutFd: fd,
          timeoutMs: perCaseMs,
        });
      } finally {
        closeSync(fd);
      }
      // A case that crashed, timed out or was killed has no output: the judge sees a missing file and fails the check.
      if (res.timedOut || res.code !== 0) unlinkSync(outFile);
    }

    // ---- integrity: nothing the judge trusts may have changed ----
    if (
      (await dirHashFromDisk(pkg)) !== pkgBefore ||
      (await dirHashFromDisk(opts.packageDir)) !== pkgBefore
    )
      return withhold("PACKAGE_TAMPERED", "The verifier package changed during the run.", sandbox);

    // ---- judge: outside the sandbox, never loads delivery code ----
    const remaining = deadline - Date.now();
    if (remaining <= 0) return withhold("VERIFY_TIMEOUT", "Verification timed out.", sandbox);
    const nodeDir = dirname(process.execPath);
    const res = await runChild(process.execPath, [join(pkg, "verify.mjs"), del, out], {
      cwd: tmp,
      env: { PATH: [nodeDir, "/usr/bin", "/bin"].join(delimiter), LANG: "C" },
      stdoutFd: "pipe",
      timeoutMs: remaining,
    });
    if ((await dirHashFromDisk(pkg)) !== pkgBefore)
      return withhold("PACKAGE_TAMPERED", "The verifier package changed during the run.", sandbox);

    if (res.timedOut)
      return withhold("VERIFY_TIMEOUT", "Verification timed out.", sandbox, res.code);
    if (res.overflow)
      return withhold("VERIFY_OUTPUT_INVALID", "Verifier output too large.", sandbox, res.code);
    const checks = parseChecks(res.stdout);
    if (checks === null) {
      return withhold(
        "VERIFY_OUTPUT_INVALID",
        "Verifier output could not be parsed.",
        sandbox,
        res.code,
      );
    }
    const anyFail = checks.some((c) => c.status === "fail");
    if (res.code === 0 && !anyFail) {
      return { outcome: "PASS", exitCode: 0, checks, sandbox, message: "All checks passed." };
    }
    if (res.code === 1 && anyFail) {
      return {
        outcome: "FAIL",
        exitCode: 1,
        checks,
        sandbox,
        message: "At least one check failed.",
      };
    }
    return withhold(
      "VERIFY_CRASH",
      "Verifier exit code and output disagree or it crashed.",
      sandbox,
      res.code,
      checks,
    );
  } catch (e) {
    return withhold("RUNNER_ERROR", `Runner error: ${(e as Error).message}`, sandbox);
  } finally {
    if (tmp !== undefined) {
      makeWritable(tmp);
      rmSync(tmp, { recursive: true, force: true });
    }
  }
}
