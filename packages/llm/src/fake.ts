import { BaseLlm } from "./base.js";
import { LlmError } from "./errors.js";
import type { CompleteRequest, CompleteResult } from "./types.js";

/** Tests only. Throws on construction when VERDICT_MODE=demo. Replies are scripted. */
export class FakeLlm extends BaseLlm {
  readonly modelName = "fake";
  readonly calls: CompleteRequest[] = [];
  private readonly replies: Array<string | Error>;

  constructor(replies: Array<string | Error | object>) {
    super();
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
    if (next instanceof Error) throw next;
    for (const t of next.match(/.{1,8}/gs) ?? []) req.onToken?.(t);
    return {
      text: next,
      stats: { ttftMs: 1, tokensPerSec: 100, generatedTokens: next.length, wallMs: 1 },
    };
  }
  async health() {
    return { ok: true, detail: "fake" };
  }
  async close() {}
}
