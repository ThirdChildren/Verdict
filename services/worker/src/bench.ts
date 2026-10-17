// pnpm --filter @verdict/worker bench - worker generation speed check, used by preflight.
// Exit 0 ok, 0 + warning below 30 tok/s, 1 below 15 tok/s (wrong GPU or power profile).
import { loadLlm } from "@verdict/llm";
import { classifyTps } from "./agent/speed.js";
import { gpuMemoryUsedMiB, peakSampler, VRAM_LIMIT_MIB } from "./vram.js";

const model = process.env.WORKER_MODEL ?? "QWEN3_5_9B_MULTIMODAL_Q4_K_M";
// The demo runs both models at once: the worker (ctx 16384) and the buyer planner (ctx 8192, services/buyer-agent/src/main.ts).
const buyerModel = process.env.BUYER_MODEL ?? "QWEN3_8B_INST_Q4_K_M";
const baseline = gpuMemoryUsedMiB();
const sampler = peakSampler();
const llm = await loadLlm({ model, ctxSize: 16384, seed: 1, temperature: 0.6 });
const buyer = await loadLlm({ model: buyerModel, ctxSize: 8192, seed: 1, temperature: 0.2 });
const r = await llm.generateText(
  [
    {
      role: "user",
      content:
        "Write a JavaScript function that parses a CSV line with quoted fields, with comments.",
    },
  ],
  { maxTokens: 300 },
);
// Both models generate once, so the KV caches and compute buffers are really allocated.
await buyer.generateText([{ role: "user", content: "Say hello in one sentence." }], {
  maxTokens: 64,
});
const peak = sampler.stop();
await buyer.close();
await llm.close();
const tps = r.stats.tokensPerSec;
const verdict = classifyTps(tps);
const line = `[worker-bench] ${model}: load ${llm.loadMs} ms, ${tps?.toFixed(1) ?? "?"} tok/s over ${r.stats.generatedTokens ?? "?"} tokens`;
if (verdict === "ok") console.log(`${line} - OK`);
else if (verdict === "warn")
  console.log(
    `${line} - WARNING: under 30 tok/s. Check AC power, power profile and that the RTX 3080 is used (docs/SETUP.md).`,
  );
else console.error(`${line} - FAILED: under 15 tok/s. Wrong GPU or power profile (docs/SETUP.md).`);
let vramBad = false;
if (peak === null) console.log("[worker-bench] VRAM: nvidia-smi not available, not checked");
else {
  vramBad = peak > VRAM_LIMIT_MIB;
  console.log(
    `[worker-bench] peak VRAM with ${model} + ${buyerModel} loaded: ${peak} MiB (idle before: ${baseline ?? "?"} MiB, limit ${VRAM_LIMIT_MIB} MiB)${vramBad ? " - FAILED: too close to the 16 GB of the RTX 3080" : " - OK"}`,
  );
}
process.exit(verdict === "fail" || vramBad ? 1 : 0);
