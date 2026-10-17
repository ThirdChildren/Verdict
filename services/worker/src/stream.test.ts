import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StreamHub } from "./stream.js";

describe("StreamHub", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("batches tokens per channel and closes with a done frame", () => {
    const hub = new StreamHub(() => Date.now());
    const got: { channel: string; text: string; tokens: number }[] = [];
    hub.subscribe((e) => got.push(e.data));
    const h = hub.attempt("task_0123456789abcdef", 2);
    h.onThinking?.("let me ");
    h.onThinking?.("think");
    h.onToken?.("```js\n");
    vi.advanceTimersByTime(200);
    h.onToken?.("code");
    h.done?.({ tokens: 40, tokPerSec: 61.5 });
    expect(got.map((g) => [g.channel, g.text])).toEqual([
      ["thinking", "let me think"],
      ["output", "```js\n"],
      ["output", "code"],
      ["done", ""],
    ]);
    const last = hub.replay().at(-1);
    expect(last?.data).toMatchObject({ attempt: 2, tokens: 40, tokens_per_sec: 61.5 });
  });

  it("reports a running tok/s from the token timing", () => {
    const hub = new StreamHub(() => Date.now());
    const h = hub.attempt("task_0123456789abcdef", 1);
    h.onToken?.("a");
    vi.advanceTimersByTime(1000);
    h.onToken?.("b");
    vi.advanceTimersByTime(200);
    const e = hub.replay().at(-1);
    expect(e?.data.tokens).toBe(2);
    expect(e?.data.tokens_per_sec).toBeGreaterThan(1);
  });
});
