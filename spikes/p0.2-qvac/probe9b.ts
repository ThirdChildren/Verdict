import { loadModel, completion, unloadModel, close, QWEN3_5_9B_MULTIMODAL_Q4_K_M } from "@qvac/sdk";
const modelId = await loadModel({ modelSrc: QWEN3_5_9B_MULTIMODAL_Q4_K_M, modelType: "llm", modelConfig: { ctx_size: 8192, seed: 1, temp: 0.2 } } as never);
const simple = { type: "object", properties: { a: { type: "integer" } }, required: ["a"], additionalProperties: false };
const cases: [string, object][] = [
  ["simple schema, thinking default", { responseFormat: { type: "json_schema", json_schema: { name: "s", schema: simple } } }],
  ["json_object", { responseFormat: { type: "json_object" } }],
  ["no format, thinking", {}],
];
for (const [name, extra] of cases) {
  const t = Date.now();
  try {
    const f = await completion({ modelId, stream: true, captureThinking: true, generationParams: { predict: 3000 }, history: [{ role: "user", content: "Reply with JSON {\"a\": 120} only." }], ...extra } as never).final;
    console.log(`[probe] ${name}: OK ${Date.now() - t}ms gen=${f.stats?.generatedTokens} thinkChars=${f.thinkingText?.length ?? 0} content=${JSON.stringify(f.contentText.slice(0, 80))}`);
  } catch (e) { console.log(`[probe] ${name}: ERR ${String((e as Error).message).slice(0, 100)}`); }
}
await unloadModel({ modelId }); await close(); process.exit(0);
