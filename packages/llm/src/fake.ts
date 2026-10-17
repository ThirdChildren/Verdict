import { BaseLlm } from "./base.js";
import { LlmError } from "./errors.js";
import type { CompleteRequest, CompleteResult } from "./types.js";

/** Tests only. Throws on construction when VERDICT_MODE=demo. Replies are scripted. */
export class FakeLlm extends BaseLlm {
  readonly modelName = "fake";
  readonly calls: CompleteRequest[] = [];
  private readonly replies: Array<string | Error>;

  private readonly delayMs: number;
  private readonly thinking: string;

  constructor(
    replies: Array<string | Error | object>,
    opts: { delayMs?: number; thinking?: string } = {},
  ) {
    super();
    this.delayMs = opts.delayMs ?? 0;
    this.thinking = opts.thinking ?? "";
    if (process.env.VERDICT_MODE === "demo") {
      throw new LlmError("LLM_FAKE_IN_DEMO", "FakeLlm must never be used in demo mode.");
    }
    this.replies = replies.map((r) =>
      typeof r === "string" || r instanceof Error ? r : JSON.stringify(r),
    );
  }

  protected async complete(req: CompleteRequest): Promise<CompleteResult> {
    this.calls.push(req);
    const next = this.replies.shift();
    if (next === undefined) throw new Error("FakeLlm: no scripted reply left");
    if (this.delayMs > 0) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, this.delayMs);
        req.signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(t);
            resolve();
          },
          { once: true },
        );
      });
      if (req.signal?.aborted) throw new Error("FakeLlm: aborted");
    }
    if (next instanceof Error) throw next;
    if (this.thinking) req.onThinking?.(this.thinking);
    for (const t of next.match(/.{1,8}/gs) ?? []) req.onToken?.(t);
    return {
      text: next,
      ...(this.thinking ? { thinking: this.thinking } : {}),
      stats: { ttftMs: 1, tokensPerSec: 100, generatedTokens: next.length, wallMs: 1 },
    };
  }
  async health() {
    return { ok: true, detail: "fake" };
  }
  async close() {}
}
