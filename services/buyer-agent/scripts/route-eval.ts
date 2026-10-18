/**
 * Routing evaluation with the real buyer model (run on the Legion, models downloaded ahead of time).
 * Run: cd services/buyer-agent && ../../node_modules/.bin/tsx scripts/route-eval.ts [catalogue.json]
 * Ship bar: at least 20/24 correct and zero false accepts. Exit code 1 when the bar is missed.
 */
import { join } from "node:path";
import { loadLlm } from "@verdict/llm";
import { BuyerAgent } from "../src/agent.js";
import { loadCases, runRouteEval } from "../src/route-eval.js";

const types = [
  {
    id: "csv2json-v1",
    description: "A command line tool that converts a CSV file to a JSON array of objects.",
  },
  {
    id: "json-normalise-v1",
    description:
      "A command line tool that prints the canonical form of a JSON file: keys sorted recursively, arrays kept in order, plain decimal numbers, 2-space indent.",
  },
];
const cases = loadCases(join(import.meta.dirname, "../eval/route-cases.json"));
const llm = await loadLlm({
  model: process.env.BUYER_MODEL ?? "QWEN3_8B_INST_Q4_K_M",
  ctxSize: 8192,
  seed: 1,
  temperature: 0.2,
});
const agent = new BuyerAgent({ llm, workers: {} });
const r = await runRouteEval(agent, cases, types);
for (const x of r.rows)
  console.log(`${x.got === x.label ? "ok  " : "MISS"} want=${x.label} got=${x.got}  ${x.request}`);
console.log(
  `accuracy ${r.correct}/${r.total}, false accepts ${r.falseAccepts}, wrong package ${r.wrongPackage}, false rejects ${r.falseRejects}`,
);
await llm.close();
process.exit(r.correct >= 20 && r.falseAccepts === 0 ? 0 : 1);
