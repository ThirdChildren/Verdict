import { BaseLlm, type BaseLlmConfig } from "./base.js";
import { LlmError } from "./errors.js";
import type { CompleteRequest, CompleteResult } from "./types.js";

/**
 * Typed against the real @qvac/sdk 0.21.0 .d.ts (type-only import; the runtime import stays lazy so unit
 * tests never load the native SDK). Streaming uses `run.events` (contentDelta), not the deprecated
 * `tokenStream`. See docs/SDK_NOTES.md "P2.2".
 */
type Sdk = typeof import("@qvac/sdk");
type ModelDescriptor = Sdk["QWEN3_8B_INST_Q4_K_M"];

export type LoadLlmOptions = BaseLlmConfig & {
  /** Export name of the QVAC model constant, e.g. "QWEN3_8B_INST_Q4_K_M". Checked against the SDK exports. */
  model: string;
  ctxSize?: number;
  seed?: number;
  temperature?: number;
  /** Run one throwaway completion after load (first call is slow). Default true. */
  warmUp?: boolean;
};

export class QvacLlm extends BaseLlm {
  readonly modelName: string;
  readonly loadMs: number;
  private constructor(
    private readonly sdk: Sdk,
    private readonly modelId: string,
    model: string,
    loadMs: number,
    cfg: BaseLlmConfig,
  ) {
    super(cfg);
    this.modelName = model;
    this.loadMs = loadMs;
  }

  static async load(opts: LoadLlmOptions): Promise<QvacLlm> {
    let sdk: Sdk;
    try {
      sdk = await import("@qvac/sdk");
    } catch (err) {
      throw new LlmError("LLM_LOAD_FAILED", "@qvac/sdk is not installed or failed to load.", {
        cause: err,
      });
    }
    const descriptor = (sdk as unknown as Record<string, unknown>)[opts.model];
    if (!isModelDescriptor(descriptor)) {
      throw new LlmError(
        "LLM_LOAD_FAILED",
        `@qvac/sdk does not export a model constant named ${opts.model}.`,
      );
    }
    const t0 = Date.now();
    let modelId: string;
    try {
      modelId = await sdk.loadModel({
        modelSrc: descriptor,
        modelConfig: {
          ctx_size: opts.ctxSize ?? 8192,
          seed: opts.seed ?? 1,
          temp: opts.temperature ?? 0.2,
        },
      });
    } catch (err) {
      throw new LlmError(
        "LLM_LOAD_FAILED",
        `Could not load ${opts.model}. Models must be pre-downloaded.`,
        { cause: err },
      );
    }
    const loadMs = Date.now() - t0;
    // Qwen3.5 rejects responseFormat (SDK_NOTES P0.2b): default it to free-text JSON.
    const defaultMode =
      opts.defaultMode ?? (opts.model.startsWith("QWEN3_5") ? "free" : "json_schema");
    const llm = new QvacLlm(sdk, modelId, opts.model, loadMs, { ...opts, defaultMode });
    if (opts.warmUp !== false) {
      await llm
        .generateText([{ role: "user", content: "Reply with: ok" }], { maxTokens: 8 })
        .catch(() => undefined);
    }
    return llm;
  }

  protected async complete(req: CompleteRequest): Promise<CompleteResult> {
    const t0 = Date.now();
    const run = this.sdk.completion({
      modelId: this.modelId,
      history: req.messages,
      stream: true,
      captureThinking: true,
      generationParams: { predict: req.maxTokens },
      ...(req.jsonSchema
        ? {
            responseFormat: {
              type: "json_schema",
              json_schema: { name: req.jsonSchema.name, schema: req.jsonSchema.schema },
            },
          }
        : {}),
    });
    let firstTokenAt: number | null = null;
    for await (const ev of run.events) {
      if (ev.type === "contentDelta") {
        firstTokenAt ??= Date.now();
        req.onToken?.(ev.text);
      } else if (ev.type === "thinkingDelta") {
        firstTokenAt ??= Date.now();
        req.onThinking?.(ev.text);
      }
    }
    const f = await run.final;
    const wallMs = Date.now() - t0;
    const gen = f.stats?.generatedTokens ?? null;
    return {
      text: f.contentText ?? "",
      ...(f.thinkingText ? { thinking: f.thinkingText } : {}),
      stats: {
        ttftMs: f.stats?.timeToFirstToken ?? (firstTokenAt === null ? null : firstTokenAt - t0),
        tokensPerSec:
          f.stats?.tokensPerSecond ?? (gen && wallMs > 0 ? (gen * 1000) / wallMs : null),
        generatedTokens: gen,
        wallMs,
      },
    };
  }

  async health() {
    try {
      const r = await this.generateText([{ role: "user", content: "Reply with: ok" }], {
        maxTokens: 8,
      });
      return {
        ok: true,
        detail: `${this.modelName} loaded in ${this.loadMs} ms, probe ${r.stats.wallMs} ms`,
      };
    } catch (err) {
      return { ok: false, detail: String(err) };
    }
  }

  async close() {
    await this.sdk.unloadModel({ modelId: this.modelId });
  }
}

function isModelDescriptor(v: unknown): v is ModelDescriptor {
  return typeof v === "object" && v !== null && "src" in v && "engine" in v;
}

export function loadLlm(opts: LoadLlmOptions): Promise<QvacLlm> {
  return QvacLlm.load(opts);
}
