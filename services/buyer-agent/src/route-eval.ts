import { readFileSync } from "node:fs";
import { AgentError, type BuyerAgent } from "./agent.js";
import type { RouteTaskType } from "./prompts.js";

export type RouteCase = { request: string; label: string };

export function loadCases(path: string): RouteCase[] {
  const b = JSON.parse(readFileSync(path, "utf8")) as { cases: RouteCase[] };
  return b.cases;
}

export type RouteEvalReport = {
  total: number;
  correct: number;
  /** A "none" case that was routed to a package: the costly error. */
  falseAccepts: number;
  /** A package case that was routed to the other package. */
  wrongPackage: number;
  /** A package case that was refused. */
  falseRejects: number;
  rows: { request: string; label: string; got: string }[];
};

/** Runs every case through BuyerAgent.route and compares with its label. Model errors count as "none". */
export async function runRouteEval(
  agent: Pick<BuyerAgent, "route">,
  cases: RouteCase[],
  types: RouteTaskType[],
): Promise<RouteEvalReport> {
  const r: RouteEvalReport = {
    total: cases.length,
    correct: 0,
    falseAccepts: 0,
    wrongPackage: 0,
    falseRejects: 0,
    rows: [],
  };
  for (const c of cases) {
    let got = "none";
    try {
      got = (await agent.route(c.request, types)).package_id;
    } catch (err) {
      if (!(err instanceof AgentError)) throw err;
    }
    if (got === c.label) r.correct++;
    else if (c.label === "none") r.falseAccepts++;
    else if (got === "none") r.falseRejects++;
    else r.wrongPackage++;
    r.rows.push({ request: c.request, label: c.label, got });
  }
  return r;
}
