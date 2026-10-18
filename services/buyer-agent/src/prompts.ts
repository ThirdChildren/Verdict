export const MANDATE_SYSTEM = `You help a person give an AI agent a small, bounded spending mandate. Reply with a single JSON object only.
Fields:
- worker: name of the worker to hire, exactly as the person names it (default "worker")
- max_total_minor: integer cents of tUSD the agent may spend in total (2 tUSD = 200). Never decimals.
- max_per_task_minor: integer cents allowed per single task (not more than max_total_minor)
- category: one of code, data, writing, research, other
- expires_minutes: integer minutes until the mandate ends (5..10080, default 720 = 12 hours; never less than 120)
- summary: one plain-language paragraph (max 600 chars) a non-technical person can read: what the agent may do, the limits, and that it never holds money or keys.
Use the amounts the person states. You only propose; the person reviews and signs, and a separate engine enforces the limits.
Example goal: "Get a CSV converter built, I can spend up to 5 tUSD, 2 per job, for 12 hours"
Example output: {"worker":"worker","max_total_minor":500,"max_per_task_minor":200,"category":"code","expires_minutes":720,"summary":"The agent may hire one worker for coding tasks. It can spend at most 5.00 tUSD in total and 2.00 tUSD per task for the next 12 hours. It cannot hold money or keys; every payment is checked and held in escrow until the work is verified."}`;

export const INTENT_SYSTEM = `You convert a user goal into ONE spend intent for a payment engine. Reply with a single JSON object only.
Fields:
- kind: always "task_payment"
- worker: name of the worker to pay, exactly as the goal names it (default "worker"). Never write ids or addresses.
- category: one of code, data, writing, research, other
- amount_minor: integer cents of tUSD (1.20 tUSD = 120, 8 tUSD = 800). Never write decimals.
- recurring: true only if the goal says it repeats, else false
- interval: "none", "weekly" or "monthly" (use "none" when recurring is false)
- task_spec: short description of the work (max 300 chars)
- deadline_minutes: integer minutes from now until the work is due (5..1440, default 60)
- rationale: one short sentence for the user (max 200 chars)
Report the amount and limits the goal states, even if they look unreasonable: a separate engine decides on them. Only the listed task types can be bought; a goal that fits none of them is refused in an earlier step, so never stretch a goal to fit.
Example goal: "Get a CSV to JSON converter built for 1.20 tUSD within 2 hours"
Example output: {"kind":"task_payment","worker":"worker","category":"code","amount_minor":120,"recurring":false,"interval":"none","task_spec":"Build a CSV to JSON converter CLI","deadline_minutes":120,"rationale":"Hiring the worker for a small one-off coding task."}`;

export type RouteTaskType = { id: string; description: string; title?: string };

/** Catalogue used when the engine has no /api/task-types (older engine): the one original package. */
export const DEFAULT_TASK_TYPES: RouteTaskType[] = [
  {
    id: "csv2json-v1",
    title: "CSV to JSON converter",
    description: "A command line tool that converts a CSV file to a JSON array of objects.",
  },
];

/** Routing prompt: pick the one package whose description the request fits exactly, else abstain with "none". */
export function routeSystem(types: RouteTaskType[]): string {
  const list = types.map((t) => `- ${t.id}: ${t.description}`).join("\n");
  return `You decide which automatic test package can verify the work a person wants to buy. Reply with a single JSON object only: {"package_id": <id or "none">, "reason": <one short sentence>}.
Verdict only buys work that one of these packages can verify:
${list}
Pick a package_id ONLY if the request asks for exactly what that package's description says. If it is close but different, or fits none, reply "none". When unsure, reply "none": refusing is correct and costs nothing; a wrong match wastes money.
Negative examples:
- "Convert this JSON file to CSV" -> {"package_id":"none","reason":"The packages convert CSV to JSON or normalise JSON, not JSON to CSV."}
- "Build me a snake game" -> {"package_id":"none","reason":"No package verifies a game."}`;
}
