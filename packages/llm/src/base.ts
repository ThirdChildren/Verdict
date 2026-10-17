import { z } from "zod";
import { LlmError, LlmTimeoutError, LlmValidationError } from "./errors.js";
import { extractJsonObject } from "./json.js";
import type {
  CallStats,
  ChatMessage,
  CompleteRequest,
  CompleteResult,
  GenerateOpts,
  LlmClient,
  StructuredOpts,
  StructuredResult,
  TextResult,
} from "./types.js";

export type TimingHook = (info: { op: string; model: string; stats: CallStats }) => void;

export type BaseLlmConfig = {
  defaultMaxTokens?: number;
  defaultMode?: "json_schema" | "free";
  onTiming?: TimingHook;
};

/** Shared structured-output / retry logic. Subclasses implement `complete`. */
export abstract class BaseLlm implements LlmClient {
  abstract readonly modelName: string;
  protected readonly defaultMaxTokens: number;
  protected readonly defaultMode: "json_schema" | "free";
  protected readonly onTiming: TimingHook | undefined;

  constructor(cfg: BaseLlmConfig = {}) {
    this.defaultMaxTokens = cfg.defaultMaxTokens ?? 600;
    this.defaultMode = cfg.defaultMode ?? "json_schema";
    this.onTiming = cfg.onTiming;
  }

  protected abstract complete(req: CompleteRequest): Promise<CompleteResult>;
  abstract health(): Promise<{ ok: boolean; detail: string }>;
  abstract close(): Promise<void>;

  /**
   * Runs one completion with an optional deadline and caller signal. On expiry we stop waiting, abort
   * `req.signal` (QvacLlm turns that into sdk.cancel) and throw LlmTimeoutError. A backend that cannot
   * cancel just has its promise abandoned and keeps running.
   */
  private async timed(
    op: string,
    req: CompleteRequest,
    limit: { deadline: number | null; signal?: AbortSignal | undefined; timeoutMs: number | null },
  ): Promise<CompleteResult> {
    const ac = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const expired = new Promise<never>((_, reject) => {
      const stop = () => {
        ac.abort();
        reject(new LlmTimeoutError(limit.timeoutMs));
      };
      if (limit.signal?.aborted) return stop();
      if (limit.signal) {
        onAbort = stop;
        limit.signal.addEventListener("abort", onAbort, { once: true });
      }
      if (limit.deadline !== null) {
        timer = setTimeout(stop, Math.max(0, limit.deadline - Date.now()));
      }
    });
    expired.catch(() => undefined);
    req.signal = ac.signal;
    let res: CompleteResult;
    try {
      const run = this.complete(req);
      run.catch(() => undefined);
      res = await Promise.race([run, expired]);
    } catch (err) {
      if (err instanceof LlmError) throw err;
      throw new LlmError("LLM_CALL_FAILED", "The local model call failed.", { cause: err });
    } finally {
      clearTimeout(timer);
      if (onAbort) limit.signal?.removeEventListener("abort", onAbort);
    }
    this.onTiming?.({ op, model: this.modelName, stats: res.stats });
    return res;
  }

  private limit(opts: { timeoutMs?: number | undefined; signal?: AbortSignal | undefined }) {
    const t = opts.timeoutMs ?? null;
    return { deadline: t === null ? null : Date.now() + t, signal: opts.signal, timeoutMs: t };
  }

  async generateText(messages: ChatMessage[], opts: GenerateOpts = {}): Promise<TextResult> {
    const req: CompleteRequest = { messages, maxTokens: opts.maxTokens ?? this.defaultMaxTokens };
    if (opts.onToken) req.onToken = opts.onToken;
    if (opts.onThinking) req.onThinking = opts.onThinking;
    const r = await this.timed("generateText", req, this.limit(opts));
    return { text: r.text, ...(r.thinking ? { thinking: r.thinking } : {}), stats: r.stats };
  }

  async structured<T>(
    schema: z.ZodType<T>,
    messages: ChatMessage[],
    opts: StructuredOpts = {},
  ): Promise<StructuredResult<T>> {
    const mode = opts.mode ?? this.defaultMode;
    const maxAttempts = 1 + Math.max(0, Math.min(opts.retries ?? 1, 3));
    const history = [...messages];
    const stats: CallStats[] = [];
    const limit = this.limit(opts);
    let thinking = "";
    let detail = "";
    let lastOutput = "";
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const req: CompleteRequest = {
        messages: history,
        maxTokens: opts.maxTokens ?? this.defaultMaxTokens,
      };
      if (mode === "json_schema") {
        req.jsonSchema = {
          name: opts.name ?? "output",
          schema: {
            ...(z.toJSONSchema(schema) as Record<string, unknown>),
            additionalProperties: false,
          },
        };
      }
      if (opts.onToken) req.onToken = opts.onToken;
      if (opts.onThinking) req.onThinking = opts.onThinking;
      const r = await this.timed("structured", req, limit);
      stats.push(r.stats);
      if (r.thinking) thinking = r.thinking;
      lastOutput = r.text;
      try {
        const raw = JSON.parse(mode === "free" ? extractJsonObject(r.text) : r.text) as unknown;
        const parsed = schema.safeParse(raw);
        if (parsed.success) return { value: parsed.data, attempts: attempt, stats, thinking };
        detail = parsed.error.message;
      } catch (e) {
        detail = `not valid JSON: ${String(e)}`;
      }
      history.push(
        { role: "assistant", content: r.text },
        {
          role: "user",
          content: `Invalid: ${detail.replace(/\s+/g, " ").slice(0, 500)}. Reply again with a corrected JSON object only.`,
        },
      );
    }
    throw new LlmValidationError(maxAttempts, detail, lastOutput);
  }
}
