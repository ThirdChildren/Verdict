import { z } from "zod";
import { LlmError, LlmValidationError } from "./errors.js";
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

  private async timed(op: string, req: CompleteRequest): Promise<CompleteResult> {
    let res: CompleteResult;
    try {
      res = await this.complete(req);
    } catch (err) {
      if (err instanceof LlmError) throw err;
      throw new LlmError("LLM_CALL_FAILED", "The local model call failed.", { cause: err });
    }
    this.onTiming?.({ op, model: this.modelName, stats: res.stats });
    return res;
  }

  async generateText(messages: ChatMessage[], opts: GenerateOpts = {}): Promise<TextResult> {
    const req: CompleteRequest = { messages, maxTokens: opts.maxTokens ?? this.defaultMaxTokens };
    if (opts.onToken) req.onToken = opts.onToken;
    if (opts.onThinking) req.onThinking = opts.onThinking;
    if (opts.signal) req.signal = opts.signal;
    const r = await this.timed("generateText", req);
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
      const r = await this.timed("structured", req);
      stats.push(r.stats);
      lastOutput = r.text;
      try {
        const raw = JSON.parse(mode === "free" ? extractJsonObject(r.text) : r.text) as unknown;
        const parsed = schema.safeParse(raw);
        if (parsed.success) return { value: parsed.data, attempts: attempt, stats };
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
