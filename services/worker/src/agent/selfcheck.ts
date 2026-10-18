import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { detectSandbox, runVerification, sandboxArgv } from "@verdict/verifier/runner";
import type { DeliveryFile } from "../store.js";
import { storeDelivery } from "../store.js";
import {
  loadPackageTask,
  type PackageTask,
  packageId,
  packagesRoot,
  readManifest,
  resolvePackageDir,
} from "./package.js";

export interface SelfCheck {
  /** PASS and FAIL come from the real verifier package; WITHHOLD means the local check could not run. */
  outcome: "PASS" | "FAIL" | "WITHHOLD";
  failedChecks: string[];
  /** Plain text for the model on a retry. */
  feedback: string;
}

/** failedChecks id used when the local sandbox is missing. */
export const NO_SANDBOX = "sandbox";

export type CheckFn = (files: DeliveryFile[]) => Promise<SelfCheck>;

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_PACKAGE_DIR = resolve(HERE, "../../../../verifier-packages/csv2json-v1");

/**
 * Hints keyed by `package_id/check_id`. Only check ids and the rule that was broken, never hidden case content.
 * A hint restates the rule so a retry is driven by the rule, not only by the broken file.
 */
export const HINTS: Record<string, string> = {
  "csv2json-v1/tests":
    'Quoting rule: a comma, a doubled quote ("") or a line break inside a quoted field is part of the value. Parse the whole file character by character with a state machine (never split on newlines or commas first). Also re-check CRLF, empty cells, a header-only file, key order, all values strings, indent 2.',
  "csv2json-v1/schema": "The output is not an array of objects with string values.",
  "csv2json-v1/no-network":
    "The code uses a forbidden import (network or process module, fetch, import() or require()).",
  "json-normalise-v1/fixtures":
    'Canonical rule: object keys sorted recursively in plain code-unit order ("B" before "a"), arrays kept in input order, numbers in plain decimal (no exponent, -0 as 0), 2-space indent, trailing newline.',
  "json-normalise-v1/visible":
    "The output differs from a shown example. Canonical rule: keys sorted recursively in code-unit order, arrays in input order, plain decimal numbers, 2-space indent, trailing newline.",
  "json-normalise-v1/schema": "The output is not valid JSON of the same shape as the input.",
  "json-normalise-v1/idempotent":
    "The same data with keys in a different order must print identical output: sort every object's keys recursively.",
  "json-normalise-v1/static":
    "The code uses a forbidden import or token (network or process modules, fetch, import(), eval).",
  "json-normalise-v1/limits": "The source file is over the size limits listed in the rules.",
  "json-normalise-v1/spec": "The output breaks one of the rules listed in the task.",
};

/** Used when a package/check pair has no specific hint. */
export const GENERIC_HINTS: Record<string, string> = {
  fixtures:
    "The output differs from the expected output for at least one test input. Compare it with the examples in the task, character by character.",
  visible: "The output differs from the expected output of a shown example.",
  schema: "The output does not have the required structure.",
  property:
    "Equivalent inputs must give identical output; the result depends on something it should ignore.",
  static: "The code uses a forbidden import or token listed in the rules.",
  limits: "The source file is over the size limits listed in the rules.",
  spec: "The output breaks one of the rules listed in the task.",
};
export const FALLBACK_HINT = "Read the task and its rules again and fix this.";

export function hintFor(pkgId: string, checkId: string, kind?: string): string {
  return (
    HINTS[`${pkgId}/${checkId}`] ??
    (kind ? GENERIC_HINTS[kind] : undefined) ??
    GENERIC_HINTS[checkId] ??
    FALLBACK_HINT
  );
}

/** Runs the entry on the visible inputs in the sandbox and describes the first output that differs. Text for the model. */
export function probeVisible(deliveryDir: string, task: PackageTask): string {
  try {
    const kind = detectSandbox();
    if (kind === null) return "";
    const base = join(deliveryDir, "..", "visible-probe");
    const scratch = join(deliveryDir, "..", "visible-scratch");
    mkdirSync(base, { recursive: true });
    mkdirSync(scratch, { recursive: true, mode: 0o777 });
    for (const p of task.visible) {
      // Pairs are capped copies; truncated ones cannot be compared, so skip them.
      if (p.input.endsWith("[... truncated]") || p.expected.endsWith("[... truncated]")) continue;
      const name = `${p.name}${task.inputExt}`;
      writeFileSync(join(base, name), p.input);
      const [cmd, args] = sandboxArgv(
        kind,
        { delivery: deliveryDir, inputs: base, scratch },
        task.entry,
        name,
        { cpuSeconds: 10, fsizeBytes: 1024 * 1024 },
      );
      const r = spawnSync(cmd, args, {
        cwd: deliveryDir,
        encoding: "utf8",
        timeout: 10000,
        env: { PATH: process.env.PATH ?? "", LANG: "C" },
      });
      if (r.error || r.status !== 0)
        return `On the shown example "${p.name}" it crashed (exit ${r.status}). Error output:\n${(r.stderr ?? "").slice(-500)}`;
      if (r.stdout.trim() !== p.expected.trim())
        return `On the shown example "${p.name}" with input ${JSON.stringify(p.input)} it printed ${JSON.stringify(r.stdout.slice(0, 400))} but the expected output is ${JSON.stringify(p.expected)}.`;
    }
    return "";
  } catch {
    return "";
  }
}

// The worker's own sample (not a test file of the package): quoted comma, doubled quotes, line break in quotes.
const SAMPLE_CSV = 'id,note\n1,"hello, world"\n2,"she said ""hi"""\n3,"line\nbreak"\n';
const SAMPLE_EXPECTED = JSON.stringify([
  { id: "1", note: "hello, world" },
  { id: "2", note: 'she said "hi"' },
  { id: "3", note: "line\nbreak" },
]);

/** What the file does on the worker's sample, run through the same sandbox as the verifier. Text for the model. */
export function probeSample(deliveryDir: string): string {
  try {
    const kind = detectSandbox();
    if (kind === null)
      return "The sample run was skipped: no sandbox is available on this machine.";
    const inputs = join(deliveryDir, "..", "sample-input");
    const scratch = join(deliveryDir, "..", "sample-scratch");
    mkdirSync(inputs, { recursive: true });
    mkdirSync(scratch, { recursive: true, mode: 0o777 });
    writeFileSync(join(inputs, "sample.csv"), SAMPLE_CSV);
    const [cmd, args] = sandboxArgv(
      kind,
      { delivery: deliveryDir, inputs, scratch },
      "csv2json.mjs",
      "sample.csv",
      { cpuSeconds: 10, fsizeBytes: 1024 * 1024 },
    );
    const r = spawnSync(cmd, args, {
      cwd: deliveryDir,
      encoding: "utf8",
      timeout: 10000,
      env: { PATH: process.env.PATH ?? "", LANG: "C" },
    });
    if (r.error || r.status !== 0)
      return `On the sample file it crashed (exit ${r.status}). Error output:\n${(r.stderr ?? "").slice(-500)}`;
    let got = "";
    try {
      got = JSON.stringify(JSON.parse(r.stdout));
    } catch {
      return `On the sample file stdout was not valid JSON: ${r.stdout.slice(0, 300)}`;
    }
    return got === SAMPLE_EXPECTED
      ? "On the worker's own sample it was correct, so the mistake is in another case (CRLF, empty cells, header-only, UTF-8)."
      : `On the sample input ${JSON.stringify(SAMPLE_CSV)} it printed ${got.slice(0, 400)} but the correct output is ${SAMPLE_EXPECTED}.`;
  } catch (e) {
    return `The sample run could not be done: ${(e as Error).message}`;
  }
}

/** Runs the package's checks through the verifier's sandboxed runner. Never throws: a failure to run is WITHHOLD. */
export function localSelfCheck(
  opts: {
    packageDir?: string;
    /** The contract's package_sha256: the package is found by hash under `packagesRoot` (never a fake PASS if absent). */
    packageSha256?: string | (() => string | undefined);
    packagesRoot?: string;
    maxVerifySeconds?: number;
    /** The paid task text; when set, the feedback starts with "This delivery is checked by <id> against the task: <spec>.". */
    spec?: string | (() => string | undefined);
    /** Test seam; defaults to the verifier's sandbox detection. */
    detect?: () => unknown;
  } = {},
): CheckFn {
  return async (files) => {
    const sha =
      typeof opts.packageSha256 === "function" ? opts.packageSha256() : opts.packageSha256;
    let packageDir: string;
    if (sha !== undefined) {
      const found = await resolvePackageDir(sha, opts.packagesRoot ?? packagesRoot());
      if (found === null)
        return {
          outcome: "WITHHOLD",
          failedChecks: [],
          feedback: `package not available locally (sha256 ${sha}); no self-check was run`,
        };
      packageDir = found;
    } else packageDir = opts.packageDir ?? process.env.VERIFIER_PACKAGE_DIR ?? DEFAULT_PACKAGE_DIR;
    // Without a sandbox nothing can be checked, so the attempt counts as failed (it is never delivered unchecked).
    if ((opts.detect ?? detectSandbox)() === null)
      return {
        outcome: "FAIL",
        failedChecks: [NO_SANDBOX],
        feedback:
          "This machine has no sandbox, so the file could not be tested and was not delivered.",
      };
    const root = mkdtempSync(join(tmpdir(), "worker-selfcheck-"));
    try {
      const { dir } = storeDelivery(root, "check", 1, files);
      const r = await runVerification({
        packageDir,
        deliveryDir: dir,
        maxVerifySeconds: opts.maxVerifySeconds ?? 30,
      });
      if (r.outcome === "PASS") return { outcome: "PASS", failedChecks: [], feedback: "" };
      if (r.outcome === "WITHHOLD")
        return { outcome: "WITHHOLD", failedChecks: [], feedback: r.message };
      const failedChecks = r.checks.filter((c) => c.status === "fail").map((c) => c.id);
      let id = basename(packageDir);
      let kinds = new Map<string, string>();
      let task: PackageTask | null = null;
      try {
        const m = readManifest(packageDir);
        id = packageId(packageDir, m);
        kinds = new Map((m.checks ?? []).map((c) => [c.id, c.kind]));
        task = loadPackageTask(packageDir);
      } catch {
        // keep the directory name
      }
      let probe = "";
      if (failedChecks.length > 0) {
        if (task === null) {
          if (id === "csv2json-v1") probe = `\n${probeSample(dir)}`;
        } else if (failedChecks.some((c) => kinds.get(c) === "fixtures")) {
          const p = probeVisible(dir, task);
          probe = p ? `\n${p}` : "";
        }
      }
      const spec = typeof opts.spec === "function" ? opts.spec() : opts.spec;
      const head = spec ? `This delivery is checked by ${id} against the task: ${spec}.\n` : "";
      const feedback = `${head}${failedChecks.map((c) => `- ${c}: failed. ${hintFor(id, c, kinds.get(c))}`).join("\n")}${probe}`;
      return { outcome: "FAIL", failedChecks, feedback };
    } catch (e) {
      return { outcome: "WITHHOLD", failedChecks: [], feedback: (e as Error).message };
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };
}
