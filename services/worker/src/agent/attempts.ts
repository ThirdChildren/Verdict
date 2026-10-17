import { type Generated, type Generator, NoCodeError, type StreamHooks } from "./generate.js";
import type { CheckFn, SelfCheck } from "./selfcheck.js";

export const MAX_ATTEMPTS = 3;

export interface Attempt {
  n: number;
  generated: Generated;
  check: SelfCheck | null;
}

export interface AttemptProgress {
  attempt: number;
  maxAttempts: number;
  /** Outcome of the previous attempt, if any. */
  previous?: SelfCheck["outcome"];
}

/** A deliberately wrong delivery for the "Sabotaged worker" demo toggle: ignores quoting, so `tests` fails and nothing else. */
export const SABOTAGED_FILES = [
  {
    path: "csv2json.mjs",
    content: `// SABOTAGED WORKER (demo switch): naive comma split, ignores quoting.
import { readFileSync } from "node:fs";
const lines = readFileSync(process.argv[2], "utf8").split("\\n").filter((l) => l.trim() !== "");
const [head = "", ...body] = lines;
const keys = head.split(",");
const out = body.map((l) => Object.fromEntries(keys.map((k, i) => [k, l.split(",")[i] ?? ""])));
process.stdout.write(\`\${JSON.stringify(out)}\\n\`);
`,
  },
];

/** Higher is better: PASS beats FAIL with fewer failed checks beats unknown beats nothing usable. */
function score(a: Attempt): number {
  if (!a.check || a.check.outcome === "WITHHOLD") return 1;
  if (a.check.outcome === "PASS") return 100;
  return 10 - a.check.failedChecks.length;
}

export interface ProduceOptions {
  generator: Generator;
  check?: CheckFn;
  spec: string;
  maxAttempts?: number;
  /** Demo switch: deliver a deliberately broken file and skip the self-check. */
  sabotaged?: boolean;
  onProgress?: (p: AttemptProgress) => void;
  /** Live tokens of attempt n, for the UI worker lane. */
  hooksFor?: (attempt: number) => StreamHooks;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

/**
 * Generate, self-check, retry with the failing output as feedback, then deliver the best attempt anyway:
 * the real verifier decides, never this loop. A generator error on a retry keeps the earlier attempt.
 */
export async function produceDelivery(
  opts: ProduceOptions,
): Promise<{ best: Attempt; attempts: Attempt[] }> {
  const max = opts.maxAttempts ?? MAX_ATTEMPTS;
  if (opts.sabotaged) {
    opts.onProgress?.({ attempt: 1, maxAttempts: 1 });
    const generated: Generated = {
      files: SABOTAGED_FILES,
      model: "sabotaged worker (demo switch)",
      generationMs: 0,
      generatedTokens: null,
      tokensPerSec: null,
    };
    const a: Attempt = { n: 1, generated, check: null };
    opts.log?.("SABOTAGED worker: delivering a deliberately broken file, self-check skipped");
    return { best: a, attempts: [a] };
  }
  const attempts: Attempt[] = [];
  let retry: { previousCode: string; feedback: string } | undefined;
  let previous: SelfCheck["outcome"] | undefined;
  let lastError: unknown;
  for (let n = 1; n <= max; n++) {
    opts.onProgress?.({ attempt: n, maxAttempts: max, ...(previous ? { previous } : {}) });
    let generated: Generated;
    const hooks = opts.hooksFor?.(n);
    try {
      generated = await opts.generator(opts.spec, retry, hooks);
      hooks?.done?.({ tokens: generated.generatedTokens, tokPerSec: generated.tokensPerSec });
    } catch (err) {
      hooks?.done?.(null);
      const msg = err instanceof Error ? err.message : String(err);
      opts.log?.("generation failed", { attempt: n, error: msg });
      lastError = err;
      if (!(err instanceof NoCodeError) || n === max) break;
      // Thinking used the whole budget: ask again, briefly, instead of failing the task.
      retry = {
        previousCode: "",
        feedback:
          "You wrote no file: your reasoning used the whole budget. Reason in at most a few lines, then write the file.",
      };
      continue;
    }
    opts.log?.("generation", {
      attempt: n,
      tokens: generated.generatedTokens,
      tokPerSec: generated.tokensPerSec === null ? null : Number(generated.tokensPerSec.toFixed(1)),
      seconds: Number((generated.generationMs / 1000).toFixed(1)),
    });
    const check = opts.check ? await opts.check(generated.files) : null;
    attempts.push({ n, generated, check });
    opts.log?.("self-check", {
      attempt: n,
      outcome: check?.outcome ?? "not run",
      failed: check?.failedChecks,
    });
    if (!check || check.outcome !== "FAIL") break;
    previous = check.outcome;
    retry = { previousCode: generated.files[0]?.content ?? "", feedback: check.feedback };
  }
  if (attempts.length === 0) throw lastError ?? new Error("no attempt produced a delivery");
  const best = attempts.reduce((x, y) => (score(y) > score(x) ? y : x));
  return { best, attempts };
}
