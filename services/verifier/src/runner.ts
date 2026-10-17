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
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveDataDir } from "@verdict/identity";
import { dirHashFromDisk } from "@verdict/protocol/node";
import { MAX_DELIVERY_BYTES } from "./extract.js";
import {
  expectedVerdict,
  genericJudgeSha256,
  judgeAllowList,
  type ManifestV2,
  parseManifest,
  sha256OfFile,
} from "./manifest.js";

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
  | "VERIFY_NONDETERMINISTIC"
  | "RUNNER_ERROR";

export interface Check {
  id: string;
  status: "pass" | "fail";
  /** Format 2 only: what the manifest says about this check (the runner recomputes them, it does not trust the judge). */
  kind?: string;
  weight?: number;
  required?: boolean;
  ms?: number;
}

export interface RunResult {
  outcome: Outcome;
  exitCode: number | null;
  checks: Check[];
  sandbox: SandboxKind | "unavailable";
  code?: RunnerCode;
  message: string;
  /** Format 2 only. */
  score?: number;
  min_score?: number;
  profile?: string;
  packageId?: string;
  /** "match": the judge (and, in the full profile, the executor) gave identical output twice. */
  determinism?: "match" | "mismatch" | "skipped";
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

// The generic judge is hashed once, when the runner is loaded; format-2 packages must carry a judge on the allow-list.
genericJudgeSha256();

const MAX_STDOUT_BYTES = 64 * 1024;
const LIMIT_AS_BYTES = 2 * 1024 ** 3;
const LIMIT_EXTRA_TASKS = 128;
const SCRATCH_BYTES = 8 * 1024 * 1024;
/** The repository checkout (may hold a local .env): hidden from the delivery on macOS, where host paths are otherwise readable. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

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
  /** Directory holding the per-case output files whose fds the executor inherits (metadata-only read on macOS). */
  outputs?: string;
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
  // delivery, the inputs and scratch only (the last matching rule wins).
  // Verified on macOS 26 (17 Oct 2026): Node must lstat every ancestor of its script (ESM realpath walk) and resolve
  // its cwd, and it fstat()s its inherited stdout (the case output file) in PlatformInit, so the run dir and the output
  // dir get a metadata-only allowance (stat, not listing nor contents). Without it every case dies at startup (getcwd
  // EPERM or SIGABRT in node::InitializeOncePerProcess) and the judge fails all checks.
  // Seatbelt matches resolved paths: a rule written with a symlinked path (/var -> /private/var on macOS) matches
  // nothing and a deny would silently not apply. Every path is therefore emitted in both its given and resolved form.
  const q = (p: string): string => JSON.stringify(p);
  const runDir = dirname(m.delivery);
  const sub = (paths: string[]): string =>
    paths
      .flatMap(realDirs)
      .map((p) => `(subpath ${q(p)})`)
      .join("");
  const lit = (paths: string[]): string =>
    paths
      .flatMap(realDirs)
      .map((p) => `(literal ${q(p)})`)
      .join("");
  const hidden = [runDir, ...(m.hide ?? [])];
  const profile = `(version 1)(allow default)(deny network*)(deny file-write*)(allow file-write* ${sub([m.scratch])}(literal "/dev/null"))(deny file-read* ${sub(hidden)})(allow file-read-metadata ${lit([runDir])}${m.outputs ? sub([m.outputs]) : ""})(allow file-read* ${sub([m.delivery, m.inputs, m.scratch])})`;
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

interface JudgeLineV2 {
  id: string;
  status: "pass" | "fail";
  required: boolean;
  weight: number;
  ms: number;
}
interface JudgeVerdictV2 {
  status: "pass" | "fail";
  score: number;
  min_score: number;
  profile: string;
}

/** Strict parse of a format-2 judge's output: one line per manifest check, in order, then `_verdict`. */
function parseJudgeV2(
  stdout: string,
  m: ManifestV2,
): { lines: JudgeLineV2[]; verdict: JudgeVerdictV2 } | null {
  const raw = stdout.split("\n").filter((l) => l.trim() !== "");
  if (raw.length !== m.checks.length + 1) return null;
  const lines: JudgeLineV2[] = [];
  let verdict: JudgeVerdictV2 | null = null;
  try {
    for (const [i, l] of raw.entries()) {
      const v = JSON.parse(l) as Record<string, unknown> | null;
      if (typeof v !== "object" || v === null) return null;
      const status = v.status;
      if (status !== "pass" && status !== "fail") return null;
      if (i === m.checks.length) {
        if (
          v.id !== "_verdict" ||
          typeof v.score !== "number" ||
          typeof v.min_score !== "number" ||
          typeof v.profile !== "string"
        )
          return null;
        verdict = { status, score: v.score, min_score: v.min_score, profile: v.profile };
      } else {
        if (
          v.id !== m.checks[i]?.id ||
          typeof v.required !== "boolean" ||
          typeof v.weight !== "number" ||
          typeof v.ms !== "number"
        )
          return null;
        lines.push({ id: String(v.id), status, required: v.required, weight: v.weight, ms: v.ms });
      }
    }
  } catch {
    return null;
  }
  return verdict === null ? null : { lines, verdict };
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
    let v2: ManifestV2 | null = null;
    try {
      manifest = readManifest(pkg);
      const parsed = parseManifest(JSON.parse(readFileSync(join(pkg, "manifest.json"), "utf8")));
      if (!parsed.ok)
        throw new Error(
          parsed.issues.map((i) => `${i.path || "manifest"}: ${i.message}`).join("; "),
        );
      if (parsed.format === 2) {
        v2 = parsed.manifest;
        // No foreign code runs outside the sandbox: the judge must be the one the verifier knows (or one it was told to allow).
        if (
          sha256OfFile(join(pkg, "verify.mjs")) !== v2.judge_sha256 ||
          !judgeAllowList().has(v2.judge_sha256)
        )
          throw new Error("judge_sha256 is not a judge this verifier allows");
      }
    } catch (e) {
      return withhold(
        "PACKAGE_INVALID",
        `Verifier package unusable: ${(e as Error).message}`,
        sandbox,
      );
    }
    const isCaseInput = (f: string): boolean =>
      f.endsWith(manifest.input_ext) &&
      (v2 === null || (!f.endsWith(v2.expected_ext) && !f.endsWith(v2.output_ext)));
    const names = readdirSync(join(pkg, manifest.cases_dir)).filter(isCaseInput).sort();
    if (names.length === 0)
      return withhold("PACKAGE_INVALID", "The package has no cases.", sandbox);
    const cases = names.map((f) => ({ input: f, stem: f.slice(0, -manifest.input_ext.length) }));
    for (const f of names) cpSync(join(pkg, manifest.cases_dir, f), join(inputs, f));
    // Format 2: the shown cases run too, under the prefix v__ (the judge reads them from there).
    if (v2?.visible_dir !== undefined) {
      const vdir = join(pkg, v2.visible_dir);
      if (!existsSync(vdir))
        return withhold("PACKAGE_INVALID", "visible_dir does not exist in the package.", sandbox);
      for (const f of readdirSync(vdir).filter(isCaseInput).sort()) {
        cpSync(join(vdir, f), join(inputs, `v__${f}`));
        cases.push({ input: `v__${f}`, stem: `v__${f.slice(0, -manifest.input_ext.length)}` });
      }
    }
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
      Math.min(manifest.case_timeout_seconds * 1000, (opts.maxVerifySeconds * 800) / cases.length),
    );
    const executeAll = async (outDir: string): Promise<RunResult | null> => {
      for (const c of cases) {
        if (deadline - Date.now() <= 0)
          return withhold("VERIFY_TIMEOUT", "Verification timed out.", sandbox);
        const outFile = join(outDir, `${c.stem}${manifest.output_ext}`);
        const fd = openSync(outFile, "w", 0o600);
        let res: ProcResult;
        try {
          const [cmd, args] = sandboxArgv(
            kind,
            {
              delivery: del,
              inputs,
              scratch,
              outputs: outDir,
              hide: [
                realpathSync(opts.packageDir),
                ...realDirs(resolveDataDir()),
                ...realDirs(REPO_ROOT),
              ],
            },
            manifest.entry,
            c.input,
            {
              cpuSeconds: Math.ceil(perCaseMs / 1000),
              fsizeBytes: manifest.max_output_bytes,
            },
          );
          res = await runChild(cmd, args, {
            cwd: tmp as string,
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
      return null;
    };
    const executed = await executeAll(out);
    if (executed !== null) return executed;

    // ---- integrity: nothing the judge trusts may have changed ----
    if (
      (await dirHashFromDisk(pkg)) !== pkgBefore ||
      (await dirHashFromDisk(opts.packageDir)) !== pkgBefore
    )
      return withhold("PACKAGE_TAMPERED", "The verifier package changed during the run.", sandbox);

    // ---- judge: outside the sandbox, never loads delivery code ----
    const nodeDir = dirname(process.execPath);
    const judgeOnce = (outDir: string): Promise<ProcResult> =>
      runChild(process.execPath, [join(pkg, "verify.mjs"), del, outDir], {
        cwd: tmp as string,
        env: { PATH: [nodeDir, "/usr/bin", "/bin"].join(delimiter), LANG: "C" },
        stdoutFd: "pipe",
        timeoutMs: Math.max(1, deadline - Date.now()),
      });
    if (deadline - Date.now() <= 0)
      return withhold("VERIFY_TIMEOUT", "Verification timed out.", sandbox);
    const res = await judgeOnce(out);
    if ((await dirHashFromDisk(pkg)) !== pkgBefore)
      return withhold("PACKAGE_TAMPERED", "The verifier package changed during the run.", sandbox);

    if (res.timedOut)
      return withhold("VERIFY_TIMEOUT", "Verification timed out.", sandbox, res.code);
    if (res.overflow)
      return withhold("VERIFY_OUTPUT_INVALID", "Verifier output too large.", sandbox, res.code);

    if (v2 !== null) {
      const profile = v2.profiles[v2.profile];
      const judged = parseJudgeV2(res.stdout, v2);
      if (profile === undefined || judged === null)
        return withhold(
          "VERIFY_OUTPUT_INVALID",
          "Verifier output could not be parsed.",
          sandbox,
          res.code,
        );
      // The runner does not trust the judge's arithmetic: it recomputes from the manifest it hashed.
      const exp = expectedVerdict(
        v2,
        judged.lines.map((l) => ({ id: l.id, status: l.status })),
      );
      const agrees =
        judged.verdict.score === exp.score &&
        judged.verdict.min_score === profile.min_score &&
        judged.verdict.profile === v2.profile &&
        (judged.verdict.status === "pass") === exp.pass &&
        judged.lines.every(
          (l) => l.required === exp.required[l.id] && l.weight === exp.weight[l.id],
        );
      if (!agrees)
        return withhold(
          "VERIFY_OUTPUT_INVALID",
          "The judge's verdict disagrees with the runner's recomputation.",
          sandbox,
          res.code,
        );

      // Determinism: the judge twice on the same outputs; the full profile also re-runs the executor when at least half the budget remains.
      let determinism: "match" | "mismatch" = "match";
      const second = await judgeOnce(out);
      if (second.timedOut)
        return withhold("VERIFY_TIMEOUT", "Verification timed out.", sandbox, second.code);
      if (second.stdout !== res.stdout || second.code !== res.code) determinism = "mismatch";
      if (
        determinism === "match" &&
        profile.determinism === "full" &&
        deadline - Date.now() >= (opts.maxVerifySeconds * 1000) / 2
      ) {
        const out2 = join(tmp, "out2");
        mkdirSync(out2, { mode: 0o700 });
        const again = await executeAll(out2);
        if (again !== null) return again;
        const third = await judgeOnce(out2);
        if (third.timedOut)
          return withhold("VERIFY_TIMEOUT", "Verification timed out.", sandbox, third.code);
        if (third.stdout !== res.stdout || third.code !== res.code) determinism = "mismatch";
      }
      if (
        (await dirHashFromDisk(pkg)) !== pkgBefore ||
        (await dirHashFromDisk(opts.packageDir)) !== pkgBefore
      )
        return withhold(
          "PACKAGE_TAMPERED",
          "The verifier package changed during the run.",
          sandbox,
        );
      const extra = {
        score: exp.score,
        min_score: profile.min_score,
        profile: v2.profile,
        packageId: v2.id,
        determinism,
      };
      const checks: Check[] = judged.lines.map((l) => ({
        id: l.id,
        status: l.status,
        kind: v2?.checks.find((c) => c.id === l.id)?.kind ?? "",
        weight: l.weight,
        required: l.required,
        ms: l.ms,
      }));
      if (determinism === "mismatch")
        return {
          outcome: "WITHHOLD",
          code: "VERIFY_NONDETERMINISTIC",
          message: "The verification gave different results on identical input.",
          exitCode: res.code,
          checks,
          sandbox,
          ...extra,
        };
      if (res.code === 0 && exp.pass)
        return {
          outcome: "PASS",
          exitCode: 0,
          checks,
          sandbox,
          message: `Passed with score ${exp.score} (minimum ${profile.min_score}).`,
          ...extra,
        };
      if (res.code === 1 && !exp.pass) {
        const requiredFailed = checks.some((c) => c.status === "fail" && c.required);
        return {
          outcome: "FAIL",
          exitCode: 1,
          checks,
          sandbox,
          message: requiredFailed
            ? "A required check failed."
            : `Score ${exp.score} is below the minimum ${profile.min_score}.`,
          ...extra,
        };
      }
      return {
        ...withhold(
          "VERIFY_CRASH",
          "Verifier exit code and output disagree or it crashed.",
          sandbox,
          res.code,
          checks,
        ),
        ...extra,
      };
    }

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
