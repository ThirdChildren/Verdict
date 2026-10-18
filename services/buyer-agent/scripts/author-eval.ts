/**
 * Authoring feasibility evaluation with the real buyer model (run on the Legion, models downloaded ahead of time).
 * Run: cd services/buyer-agent && ../../node_modules/.bin/tsx scripts/author-eval.ts
 * Ship bar: at least 20/24 labels right and zero `none` requests labelled cli or reframe (the engine-install
 * half of the bar is checked by the engine tests). Exit code 1 when the bar is missed.
 */
import { join } from "node:path";
import { loadLlm } from "@verdict/llm";
import { BuyerAgent } from "../src/agent.js";
import { loadAuthorCases, runAuthorEval } from "../src/author-eval.js";

const cases = loadAuthorCases(join(import.meta.dirname, "../eval/author-cases.json"));
const llm = await loadLlm({
  model: process.env.BUYER_MODEL ?? "QWEN3_8B_INST_Q4_K_M",
  ctxSize: 8192,
  seed: 1,
  temperature: 0.2,
});
const agent = new BuyerAgent({ llm, workers: {} });
const r = await runAuthorEval(agent, cases);
for (const x of r.rows)
  console.log(`${x.got === x.label ? "ok  " : "MISS"} want=${x.label} got=${x.got}  ${x.request}`);
console.log(`accuracy ${r.correct}/${r.total}, none labelled cli/reframe ${r.noneAccepted}`);
await llm.close();
process.exit(r.correct >= 20 && r.noneAccepted === 0 ? 0 : 1);
