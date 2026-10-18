import { z } from "zod";

/** Closed vocabulary of verifier-packages/_judge/README.md ("spec assertions"). An unknown key is refused. */
export const assertionsSchema = z
  .object({
    output_keys_required: z.array(z.string().min(1).max(60)).max(20).optional(),
    max_output_bytes: z.number().int().min(1).max(65536).optional(),
    numbers_subset_of_input: z.literal(true).optional(),
    required_tokens: z.array(z.string().min(1).max(60)).max(20).optional(),
    forbidden_tokens: z.array(z.string().min(1).max(60)).max(20).optional(),
  })
  .strict();

const pair = z.object({ input: z.string().max(2048), expected: z.string().max(2048) }).strict();

/**
 * E33 FR1 draft. `reason` comes first so the model commits to a verdict before it writes cases. For `none` the
 * remaining fields may be absent; for `cli` and `reframe` they are required (checked below).
 */
export const authorSchema = z
  .object({
    reason: z.string().min(1).max(200),
    feasibility: z.enum(["cli", "reframe", "none"]),
    reframe: z.string().min(1).max(300).optional(),
    title: z.string().min(1).max(60).optional(),
    description: z.string().min(1).max(600).optional(),
    entry: z
      .string()
      .regex(/^[a-z][a-z0-9-]{1,30}\.mjs$/)
      .optional(),
    input_ext: z.enum([".txt", ".json", ".csv"]).optional(),
    visible: z.array(pair).length(3).optional(),
    hidden: z.array(pair).min(5).max(8).optional(),
    assertions: assertionsSchema.optional(),
  })
  .strict()
  .superRefine((d, ctx) => {
    if (d.feasibility === "none") return;
    const need = ["title", "description", "entry", "input_ext", "visible", "hidden"] as const;
    for (const k of need)
      if (d[k] === undefined) ctx.addIssue({ code: "custom", path: [k], message: "required" });
    if (d.feasibility === "reframe" && d.reframe === undefined)
      ctx.addIssue({ code: "custom", path: ["reframe"], message: "required for reframe" });
  });

export type AuthorModelOutput = z.infer<typeof authorSchema>;

export type AuthorPair = { input: string; expected: string };
/** What the engine receives (POST /api/task-types takes `draft`). */
export type AuthorDraft = {
  title: string;
  description: string;
  entry: string;
  input_ext: ".txt" | ".json" | ".csv";
  visible: AuthorPair[];
  hidden: AuthorPair[];
  assertions: z.infer<typeof assertionsSchema>;
};

export const NOT_VERIFIABLE_TEXT =
  "Verdict cannot pay for this: no fixed input and output can decide whether it is done, so no test could release the money. It verifies programs that read an input and print an output.";

export class DraftError extends Error {}

const stripFence = (s: string): string => {
  const m = /^\s*```[A-Za-z0-9]*[ \t]*\r?\n([\s\S]*?)\r?\n?```\s*$/.exec(s);
  return m ? (m[1] ?? "") : s;
};

/** Hygiene before the draft leaves the buyer: fences stripped, nothing empty, inputs distinct, outputs vary. */
export function cleanDraft(d: AuthorModelOutput): AuthorDraft {
  const fix = (p: AuthorPair): AuthorPair => ({
    input: stripFence(p.input),
    expected: stripFence(p.expected),
  });
  const visible = (d.visible ?? []).map(fix);
  const hidden = (d.hidden ?? []).map(fix);
  const all = [...visible, ...hidden];
  if (all.some((p) => p.input.trim() === "" || p.expected.trim() === ""))
    throw new DraftError("a test case has an empty input or output");
  const inputs = new Set(all.map((p) => p.input.trim()));
  if (inputs.size !== all.length) throw new DraftError("two test cases use the same input");
  const outs = new Set(
    all.map((p) =>
      p.expected
        .split("\n")
        .map((l) => l.trim())
        .join("\n")
        .trim(),
    ),
  );
  if (outs.size < 2) throw new DraftError("every test case expects the same output");
  return {
    title: d.title ?? "",
    description: d.description ?? "",
    entry: d.entry ?? "",
    input_ext: d.input_ext ?? ".txt",
    visible,
    hidden,
    assertions: d.assertions ?? {},
  };
}

export const AUTHOR_SYSTEM = `You write the acceptance test for a piece of work a person wants to buy. A separate verifier will run a program against your test and pay only if it passes; you never grade.
The verifier can only check a command line program: it is run as "node program.mjs <input file>" and judged by its printed standard output, compared as exact text after trimming each line. Reply with a single JSON object only. Write "reason" FIRST.
Fields:
- reason: one sentence (max 200 chars) justifying the feasibility
- feasibility: "cli" if the request is already a program that reads one input and prints one output (sum numbers, word count, CSV column filter, date reformat, unit conversion, dedupe lines, JSON field extraction, Roman numerals); "reframe" if it is interactive (a game, a UI, a web app): turn it into its logic as a command line program that reads a JSON state and a move and prints the new state, e.g. a snake game becomes a snake.mjs that reads {"board","snake","food","move"} and prints {"snake","food","alive"}. For a game or UI the program reads a JSON state and a move from the input file and prints the next state as JSON. Worked example (two DISTINCT inputs, different outputs): input {"board":[5,5],"snake":[[2,2],[2,1]],"food":[0,0],"move":"right"} -> {"snake":[[2,3],[2,2]],"food":[0,0],"alive":true}; input {"board":[5,5],"snake":[[0,4],[0,3]],"food":[1,1],"move":"right"} -> {"snake":[[0,4],[0,3]],"food":[1,1],"alive":false}. Never repeat an input; "none" if no fixed input and output can decide that it is done (research, opinions, designs, translations, prose, scraping, anything whose right answer is not one exact text).
- reframe: only for "reframe": one sentence (max 300 chars) saying what program will be tested instead
For "none" write only reason and feasibility. For "cli" and "reframe" also write:
- title (max 60), description (max 600; say exactly what the program reads and prints, the output format, and every edge case, because the worker sees only this and the visible cases)
- entry: file name like "sum-numbers.mjs" (lowercase letters, digits, hyphens)
- input_ext: ".txt", ".json" or ".csv"
- visible: exactly 3 cases {"input","expected"}; hidden: 5 to 8 different cases covering edge cases. Inputs are all different. Expected outputs are the exact stdout and must not all be equal; compute them carefully by hand. No code fences, no empty strings.
- assertions: optional object with only these keys: output_keys_required (list), max_output_bytes (number), numbers_subset_of_input (true), required_tokens (list), forbidden_tokens (list). Use {} when unsure.
Example request: "write a script that adds two numbers"
Example output: {"reason":"Reads two numbers and prints their sum: fixed input and output.","feasibility":"cli","title":"Add two numbers","description":"Read the file given as argv[2]; it holds two integers separated by a space. Print their sum and a newline.","entry":"add-two.mjs","input_ext":".txt","visible":[{"input":"1 2","expected":"3"},{"input":"10 20","expected":"30"},{"input":"-5 5","expected":"0"}],"hidden":[{"input":"0 0","expected":"0"},{"input":"100 250","expected":"350"},{"input":"-3 -4","expected":"-7"},{"input":"7 8","expected":"15"},{"input":"1000 1","expected":"1001"}],"assertions":{}}
Example request: "write an essay on inflation" -> {"reason":"An essay has no single correct text, so no test can decide it.","feasibility":"none"}`;
