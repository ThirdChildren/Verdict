import { loadModel, unloadModel, close, QWEN3_4B_INST_Q4_K_M, QWEN3_8B_INST_Q4_K_M, QWEN3_5_9B_MULTIMODAL_Q4_K_M } from "@qvac/sdk";
const all = { "4b": QWEN3_4B_INST_Q4_K_M, "8b": QWEN3_8B_INST_Q4_K_M, "9b": QWEN3_5_9B_MULTIMODAL_Q4_K_M } as const;
const which = (process.argv[2] ?? "9b") as keyof typeof all;
const t = Date.now();
const id = await loadModel({ modelSrc: all[which], modelType: "llm" } as never);
console.log(`[warm ${which}] load ${Date.now() - t} ms`);
await unloadModel({ modelId: id }); await close(); process.exit(0);
