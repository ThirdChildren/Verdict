import type { z } from "zod";

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export type CallStats = {
  /** Time to first token, ms. */
  ttftMs: number | null;
  /** Generated tokens per second (null when unknown). */
  tokensPerSec: number | null;
  generatedTokens: number | null;
  wallMs: number;
};

export type CompleteRequest = {
  messages: ChatMessage[];
  maxTokens: number;
  /** JSON Schema for grammar-constrained output; omitted for free text. */
  jsonSchema?: { name: string; schema: Record<string, unknown> };
  onToken?: (token: string) => void;
  /** Reasoning tokens (QVAC thinkingDelta), streamed separately from the answer. */
  onThinking?: (token: string) => void;
  signal?: AbortSignal;
};

export type CompleteResult = { text: string; thinking?: string; stats: CallStats };

export type StructuredOpts = {
  name?: string;
  maxTokens?: number;
  /** "json_schema" = grammar constrained; "free" = prompt-only JSON, first "{" to last "}". Default: client default. */
  mode?: "json_schema" | "free";
  /** Extra attempts after the first (default 1: one retry with the error appended). */
  retries?: number;
  onToken?: (token: string) => void;
};

export type GenerateOpts = {
  maxTokens?: number;
  onToken?: (token: string) => void;
  onThinking?: (token: string) => void;
  signal?: AbortSignal;
};

export type StructuredResult<T> = { value: T; attempts: number; stats: CallStats[] };
export type TextResult = { text: string; thinking?: string; stats: CallStats };

export interface LlmClient {
  readonly modelName: string;
  structured<T>(
    schema: z.ZodType<T>,
    messages: ChatMessage[],
    opts?: StructuredOpts,
  ): Promise<StructuredResult<T>>;
  generateText(messages: ChatMessage[], opts?: GenerateOpts): Promise<TextResult>;
  health(): Promise<{ ok: boolean; detail: string }>;
  close(): Promise<void>;
}
