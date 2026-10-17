import {
  DEFAULT_MAX_TOKENS,
  type Generated,
  type Generator,
  NoCodeError,
  type StreamHooks,
} from "./generate.js";
import { type CheckFn, NO_SANDBOX, type SelfCheck } from "./selfcheck.js";

export const MAX_ATTEMPTS = 3;

export interface Attempt {
  n: number;
  generated: Generated;
  check: SelfCheck | null;
  /** ISO times of this attempt. */
  started_at: string;
  ended_at: string;
  /** done = generated; timeout = ran out of time (nothing usable, empty files); aborted = stopped by the caller. */
  reason: AttemptReason;
}

export type AttemptReason = "done" | "timeout" | "aborted";

/** Seconds kept free before `deadline - max_verify_seconds`. */
export const SAFETY_SECONDS = 20;
/** Fixed per-attempt cap when no speed was measured (env WORKER_ATTEMPT_TIMEOUT_MS overrides). 4000 tokens at 17 tok/s. */
export const DEFAULT_ATTEMPT_TIMEOUT_MS = 240_000;

/** The latest moment generation may still run: deadline - max_verify_seconds - safety. */
export function mustDeliverBy(
  deadlineMs: number,
  maxVerifySeconds: number,
  safetySeconds = SAFETY_SECONDS,
) {
  return deadlineMs - (maxVerifySeconds + safetySeconds) * 1000;
}

const usable = (a: Attempt) =>
  a.generated.files.length > 0 && !a.check?.failedChecks.includes(NO_SANDBOX);

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
  if (!usable(a)) return -1;
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
  /** Contract deadline (ms epoch) and the verifier's time budget; together they bound the whole loop. */
  deadlineMs?: number;
  maxVerifySeconds?: number;
  safetySeconds?: number;
  /** Fixed per-attempt cap, ms. Default env WORKER_ATTEMPT_TIMEOUT_MS or DEFAULT_ATTEMPT_TIMEOUT_MS. */
  attemptTimeoutMs?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  now?: () => number;
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
    const t = new Date((opts.now ?? Date.now)()).toISOString();
    const a: Attempt = { n: 1, generated, check: null, started_at: t, ended_at: t, reason: "done" };
    opts.log?.("SABOTAGED worker: delivering a deliberately broken file, self-check skipped");
    return { best: a, attempts: [a] };
  }
  const now = opts.now ?? Date.now;
  const iso = () => new Date(now()).toISOString();
  const envCap = Number(process.env.WORKER_ATTEMPT_TIMEOUT_MS);
  const fixedCap =
    opts.attemptTimeoutMs ??
    (Number.isFinite(envCap) && envCap > 0 ? envCap : DEFAULT_ATTEMPT_TIMEOUT_MS);
  const limit =
    opts.deadlineMs === undefined
      ? Number.POSITIVE_INFINITY
      : mustDeliverBy(opts.deadlineMs, opts.maxVerifySeconds ?? 0, opts.safetySeconds);
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
  const attempts: Attempt[] = [];
  let retry: { previousCode: string; feedback: string } | undefined;
  let previous: SelfCheck["outcome"] | undefined;
  let lastError: unknown;
  let lastTps: number | null = null;
  for (let n = 1; n <= max; n++) {
    const remaining = limit - now();
    if (remaining <= 0) {
      opts.log?.("out of time before the attempt, no further attempts", { attempt: n });
      lastError ??= new Error("There was not enough time left to produce the delivery.");
      break;
    }
    // Per attempt: the time left, the fixed cap, and (when a speed was measured) 1.25x the time 4000 tokens need.
    const measuredCap = lastTps && lastTps > 0 ? Math.ceil((maxTokens / lastTps) * 1250) : fixedCap;
    const timeoutMs = Math.max(1, Math.floor(Math.min(remaining, fixedCap, measuredCap)));
    opts.onProgress?.({ attempt: n, maxAttempts: max, ...(previous ? { previous } : {}) });
    const startedAt = iso();
    const ac = new AbortController();
    const onExt = () => ac.abort();
    if (opts.signal?.aborted) ac.abort();
    else opts.signal?.addEventListener("abort", onExt, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new AttemptTimeout()); // before abort, so the timeout wins the race
        ac.abort();
      }, timeoutMs);
    });
    timedOut.catch(() => undefined);
    let generated: Generated;
    const hooks = opts.hooksFor?.(n);
    try {
      const run = opts.generator(opts.spec, retry, hooks, { signal: ac.signal, timeoutMs });
      run.catch(() => undefined);
      generated = await Promise.race([run, timedOut]);
      hooks?.done?.({ tokens: generated.generatedTokens, tokPerSec: generated.tokensPerSec });
    } catch (err) {
      hooks?.done?.(null);
      const msg = err instanceof Error ? err.message : String(err);
      opts.log?.("generation failed", { attempt: n, error: msg });
      lastError = err;
      const isTimeout =
        err instanceof AttemptTimeout || (err as { code?: string } | null)?.code === "LLM_TIMEOUT";
      if (isTimeout || opts.signal?.aborted) {
        const reason: AttemptReason = opts.signal?.aborted ? "aborted" : "timeout";
        attempts.push({
          n,
          generated: {
            files: [],
            model: "",
            generationMs: Math.max(0, now() - Date.parse(startedAt)),
            generatedTokens: null,
            tokensPerSec: null,
          },
          check: null,
          started_at: startedAt,
          ended_at: iso(),
          reason,
        });
        lastError = new Error(
          reason === "aborted"
            ? "The work was stopped before a delivery was ready."
            : "The model ran out of time before it produced a delivery.",
        );
        // Out of time: no further attempts. A per-attempt cap hit with time left may try again.
        if (reason === "aborted" || limit - now() <= 0) break;
        retry = undefined;
        continue;
      }
      if (!(err instanceof NoCodeError) || n === max) break;
      // Thinking used the whole budget: ask again, briefly, instead of failing the task.
      retry = {
        previousCode: "",
        feedback:
          "You wrote no file: your reasoning used the whole budget. Reason in at most a few lines, then write the file.",
      };
      continue;
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onExt);
    }
    lastTps = generated.tokensPerSec;
    opts.log?.("generation", {
      attempt: n,
      tokens: generated.generatedTokens,
      tokPerSec: generated.tokensPerSec === null ? null : Number(generated.tokensPerSec.toFixed(1)),
      seconds: Number((generated.generationMs / 1000).toFixed(1)),
    });
    const check = opts.check ? await opts.check(generated.files) : null;
    attempts.push({ n, generated, check, started_at: startedAt, ended_at: iso(), reason: "done" });
    opts.log?.("self-check", {
      attempt: n,
      outcome: check?.outcome ?? "not run",
      failed: check?.failedChecks,
    });
    if (check?.outcome !== "FAIL" || check.failedChecks.includes(NO_SANDBOX)) {
      if (check?.failedChecks.includes(NO_SANDBOX)) lastError = new Error(check.feedback);
      break;
    }
    previous = check.outcome;
    retry = { previousCode: generated.files[0]?.content ?? "", feedback: check.feedback };
  }
  const candidates = attempts.filter(usable);
  if (candidates.length === 0) throw lastError ?? new Error("no attempt produced a delivery");
  const best = candidates.reduce((x, y) => (score(y) > score(x) ? y : x));
  return { best, attempts };
}

class AttemptTimeout extends Error {
  constructor() {
    super("attempt timed out");
  }
}
