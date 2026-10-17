import { spawn, execSync } from "node:child_process";
import { loadModel, completion, unloadModel, close, QWEN3_4B_INST_Q4_K_M, QWEN3_5_9B_MULTIMODAL_Q4_K_M } from "@qvac/sdk";
import { z } from "zod";

const role = process.argv[2];
const vram = () => execSync("nvidia-smi --query-gpu=memory.used,memory.total --format=csv,noheader").toString().trim();

if (!role) {
  const kids = ["small", "big"].map((r) => spawn(process.execPath, ["--import", "tsx", import.meta.filename, r], { stdio: ["inherit", "inherit", "inherit", "ipc"] }));
  let loaded = 0;
  const done = Promise.all(kids.map((k) => new Promise((res) => k.on("exit", res))));
  kids.forEach((k) => k.on("message", (m) => {
    if (m === "loaded" && ++loaded === 2) { console.log("[launcher] VRAM with both loaded (used,total MiB):", vram()); kids.forEach((x) => x.send("go")); }
  }));
  await done;
  console.log("[launcher] VRAM after exit:", vram());
  process.exit(0);
}

const Intent = z.object({
  kind: z.literal("task_payment"), category: z.string(), counterparty: z.string(),
  amount: z.string().regex(/^\d+(\.\d+)?$/), recurring: z.boolean(), interval: z.null(),
  task_spec: z.string(), deadline: z.string(), rationale: z.string(),
}).strict();

const t0 = Date.now();
const modelId = await loadModel({ modelSrc: role === "small" ? QWEN3_4B_INST_Q4_K_M : QWEN3_5_9B_MULTIMODAL_Q4_K_M, modelType: "llm", modelConfig: { ctx_size: 8192, seed: 1, temp: 0.2 } } as never);
console.log(`[${role}] load ${Date.now() - t0} ms (includes download on first run)`);
process.send?.("loaded");
await new Promise((r) => process.on("message", (m) => m === "go" && r(null)));

async function run(prompt: string, max: number, schema?: object) {
  const t = Date.now();
  const r = completion({ modelId, stream: true, captureThinking: true, generationParams: { predict: max }, history: [{ role: "user", content: prompt }],
    ...(schema ? { responseFormat: { type: "json_schema", json_schema: { name: "x", schema } } } : {}) } as never);
  const f = await r.final; const wall = Date.now() - t;
  return { f, wall };
}
const log = (f: any, wall: number) => console.log(`[${role}] ttft=${f.stats?.timeToFirstToken} (raw) tps=${f.stats?.tokensPerSecond?.toFixed?.(1)} gen=${f.stats?.generatedTokens} dev=${f.stats?.backendDevice} wall=${wall}ms stop=${f.stopReason} thinkingChars=${f.thinkingText?.length ?? 0}`);

if (role === "small") {
  const schema = { ...(z.toJSONSchema(Intent) as object), additionalProperties: false };
  let ok = 0;
  for (let i = 0; i < 10; i++) {
    const { f, wall } = await run(`Return a spend intent JSON: pay worker w-${i} 1.${i}0 tUSD for a CSV-to-JSON CLI, category code, deadline 2026-10-18T16:15:00Z, not recurring, interval null, counterparty is the worker id.`, 600, schema);
    let v = false; try { v = Intent.safeParse(JSON.parse(f.contentText)).success; } catch {}
    if (v) ok++; else if (i < 3) console.log("[small] invalid:", JSON.stringify(f.contentText.slice(0, 400)));
    if (i < 2) log(f, wall);
  }
  console.log(`[small] Zod-valid ${ok}/10`);
} else {
  const { f, wall } = await run("Write a zero-dependency Node.js ESM CLI csv2json.mjs: reads CSV path from argv[2], handles quoted fields with commas and escaped quotes, prints a JSON array of objects keyed by header. Output only the code.", 6000);
  log(f, wall);
  console.log(`[big] content chars=${f.contentText.length} thinkingChars=${f.thinkingText?.length ?? 0} head=${JSON.stringify(f.contentText.slice(0, 120))}`);
}
await unloadModel({ modelId }); await close(); process.exit(0);
