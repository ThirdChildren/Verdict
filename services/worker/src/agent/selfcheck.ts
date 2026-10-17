import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { detectSandbox, runVerification, sandboxArgv } from "@verdict/verifier/runner";
import type { DeliveryFile } from "../store.js";
import { storeDelivery } from "../store.js";

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

const HINTS: Record<string, string> = {
  tests:
    "Your tool printed the wrong JSON for at least one of the six test files. Re-check: a quoted field that contains a line break (parse the whole file character by character, never split on newlines first), doubled quotes, CRLF, empty cells, header-only file, key order, all values strings, indent 2.",
  schema: "The output is not an array of objects with string values.",
  "no-network":
    "The code uses a forbidden import (network or process module, fetch, import() or require()).",
};

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

/** Runs the package's own verify.sh through the verifier's sandboxed runner. Never throws: a failure to run is WITHHOLD. */
export function localSelfCheck(
  opts: {
    packageDir?: string;
    maxVerifySeconds?: number;
    /** Test seam; defaults to the verifier's sandbox detection. */
    detect?: () => unknown;
  } = {},
): CheckFn {
  const packageDir = opts.packageDir ?? process.env.VERIFIER_PACKAGE_DIR ?? DEFAULT_PACKAGE_DIR;
  return async (files) => {
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
      const probe = failedChecks.length > 0 ? `\n${probeSample(dir)}` : "";
      const feedback = `${failedChecks.map((id) => `- ${id}: failed. ${HINTS[id] ?? ""}`).join("\n")}${probe}`;
      return { outcome: "FAIL", failedChecks, feedback };
    } catch (e) {
      return { outcome: "WITHHOLD", failedChecks: [], feedback: (e as Error).message };
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };
}
