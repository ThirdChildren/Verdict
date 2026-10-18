import { readFileSync } from "node:fs";
import { AgentError, type BuyerAgent } from "./agent.js";

export type AuthorLabel = "cli" | "reframe" | "none";
export type AuthorCase = { request: string; label: AuthorLabel };

export function loadAuthorCases(path: string): AuthorCase[] {
  return (JSON.parse(readFileSync(path, "utf8")) as { cases: AuthorCase[] }).cases;
}

export type AuthorEvalReport = {
  total: number;
  correct: number;
  /** A `none` request that produced a draft (cli or reframe): the costly error. */
  noneAccepted: number;
  rows: { request: string; label: string; got: string }[];
};

/** Model failures (AUTHOR_FAILED) count as "failed"; a none verdict counts as "none". */
export async function runAuthorEval(
  agent: Pick<BuyerAgent, "author">,
  cases: AuthorCase[],
): Promise<AuthorEvalReport> {
  const r: AuthorEvalReport = { total: cases.length, correct: 0, noneAccepted: 0, rows: [] };
  for (const c of cases) {
    let got = "failed";
    try {
      got = (await agent.author(c.request)).feasibility;
    } catch (err) {
      if (!(err instanceof AgentError)) throw err;
      if (err.code === "TASK_NOT_VERIFIABLE") got = "none";
    }
    if (got === c.label) r.correct++;
    if (c.label === "none" && (got === "cli" || got === "reframe")) r.noneAccepted++;
    r.rows.push({ request: c.request, label: c.label, got });
  }
  return r;
}
