// pnpm --filter @verdict/worker measure -- --runs 10 --max-tokens 2500
// Real model, real verify.sh self-check, serial runs. Prints PASS count and the slowest run. Never part of unit tests.
import { loadLlm } from "@verdict/llm";
import { produceDelivery } from "./agent/attempts.js";
import { llmGenerator } from "./agent/generate.js";
import { localSelfCheck } from "./agent/selfcheck.js";

const arg = (name: string, d: number): number => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? Number(process.argv[i + 1]) : d;
};
const runs = arg("runs", 10);
const maxTokens = arg("max-tokens", 4000);
const model = process.env.WORKER_MODEL ?? "QWEN3_5_9B_MULTIMODAL_Q4_K_M";
const spec =
  "Write csv2json.mjs: a zero-dependency Node ESM CLI that converts a CSV file (quoted fields, CRLF, UTF-8) to a JSON array of objects.";

const llm = await loadLlm({ model, ctxSize: 16384, seed: 1, temperature: 0.6 });
const generator = llmGenerator(llm, maxTokens);
const check = localSelfCheck();
let pass = 0;
let maxSec = 0;
const secs: number[] = [];
for (let i = 1; i <= runs; i++) {
  const t0 = Date.now();
  let outcome = "ERROR";
  let attempts = 0;
  try {
    const r = await produceDelivery({ generator, check, spec });
    outcome = r.best.check?.outcome ?? "not run";
    attempts = r.attempts.length;
  } catch {
    // no attempt produced code: counts as a failed run
  }
  const s = (Date.now() - t0) / 1000;
  secs.push(Number(s.toFixed(0)));
  maxSec = Math.max(maxSec, s);
  if (outcome === "PASS") pass++;
  console.log(
    `[measure] maxTokens=${maxTokens} run ${i}/${runs}: ${outcome} attempts=${attempts} ${s.toFixed(0)} s`,
  );
}
await llm.close();
console.log(
  `[measure] maxTokens=${maxTokens}: ${pass}/${runs} PASS, max ${maxSec.toFixed(0)} s, seconds ${secs.join(",")}`,
);
process.exit(0);
