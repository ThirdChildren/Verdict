import { z } from "zod";

const pair = z.object({ input: z.string(), expected: z.string() }).passthrough();
const rule = z.union([z.string(), z.record(z.string(), z.unknown())]);

/** The acceptance-test draft the buyer agent writes (POST /api/author). Unknown fields are kept and sent back. */
export const draftSchema = z
  .object({
    feasibility: z.enum(["cli", "reframe"]),
    reason: z.string().default(""),
    reframe: z.string().optional(),
    title: z.string(),
    description: z.string().default(""),
    entry: z.string().optional(),
    input_ext: z.string().optional(),
    visible: z.array(pair),
    hidden: z.array(pair),
    assertions: z.union([z.record(z.string(), z.unknown()), z.array(rule)]).default([]),
  })
  .passthrough();
export type Draft = z.infer<typeof draftSchema>;

/** Reads the author answer: the top-level feasibility, reason and reframe are merged into one draft object. */
export function parseAuthorAnswer(raw: unknown): Draft | null {
  return readAuthorAnswer(raw).draft;
}

/** Same, with the first zod problem as "<path>: <message>" when the answer cannot be read. */
export function readAuthorAnswer(raw: unknown): { draft: Draft | null; problem: string } {
  const o = z
    .object({
      feasibility: z.string().optional(),
      reason: z.string().optional(),
      reframe: z.string().optional(),
      draft: z.record(z.string(), z.unknown()),
    })
    .safeParse(raw);
  if (!o.success) return { draft: null, problem: firstProblem(o.error, "answer") };
  const { draft, feasibility, reason, reframe } = o.data;
  const merged = {
    ...draft,
    ...(feasibility === undefined ? {} : { feasibility }),
    ...(reason === undefined ? {} : { reason }),
    ...(reframe === undefined ? {} : { reframe }),
  };
  const r = draftSchema.safeParse(merged);
  return r.success
    ? { draft: r.data, problem: "" }
    : { draft: null, problem: firstProblem(r.error, "draft") };
}

function firstProblem(error: z.ZodError, root: string): string {
  const i = error.issues[0];
  if (!i) return `${root}: invalid`;
  return `${i.path.length > 0 ? i.path.join(".") : root}: ${i.message}`;
}

/** What POST /api/task-types answers on success. */
export const installedSchema = z
  .object({
    id: z.string().min(1),
    package_sha256: z.string().default(""),
    title: z.string().optional(),
  })
  .passthrough();
export type Installed = z.infer<typeof installedSchema>;

/** UI-only engine event: a task type was installed. */
const addedBody = z.object({
  id: z.string().min(1),
  title: z.string().optional(),
  package_sha256: z.string().default(""),
});
export interface TaskTypeAdded {
  id: string;
  title: string;
  package_sha256: string;
}
export function parseTypeAddedEvent(raw: unknown): TaskTypeAdded | null {
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  const env = z
    .object({ type: z.literal("TASK_TYPE_ADDED"), data: addedBody.optional() })
    .passthrough()
    .safeParse(value);
  if (!env.success) return null;
  const b = addedBody.safeParse(env.data.data ?? value);
  if (!b.success) return null;
  return {
    id: b.data.id,
    title: b.data.title?.trim() || b.data.id,
    package_sha256: b.data.package_sha256,
  };
}

const listOf = (v: unknown): string =>
  Array.isArray(v) ? v.map((x) => String(x)).join(", ") : String(v);

/** One engine assertion key as a sentence; unknown keys stay readable as key and value. */
export function assertionSentence(key: string, v: unknown): string | null {
  switch (key) {
    case "max_output_bytes":
      return `Output at most ${String(v)} bytes`;
    case "forbidden_tokens":
      return `Must not contain: ${listOf(v)}`;
    case "required_tokens":
      return `Must contain: ${listOf(v)}`;
    case "output_keys_required":
      return `Output must have the keys: ${listOf(v)}`;
    case "numbers_subset_of_input":
      return v ? "Every number in the output must appear in the input" : null;
    default:
      return `${key}: ${JSON.stringify(v)}`;
  }
}

/** All rules of a draft as sentences: the engine's object form or a list of rules. */
export function rulesOf(a: Draft["assertions"]): string[] {
  if (Array.isArray(a)) return a.map(ruleText);
  return Object.entries(a)
    .map(([k, v]) => assertionSentence(k, v))
    .filter((x): x is string => x !== null);
}

/** A rule as one sentence: strings as they are, objects by their first text-like field. */
export function ruleText(r: string | Record<string, unknown>): string {
  if (typeof r === "string") return r;
  for (const k of ["text", "description", "rule", "message", "says"]) {
    const v = r[k];
    if (typeof v === "string") return v;
  }
  return JSON.stringify(r);
}

export const hash8 = (sha: string): string => sha.slice(0, 8);

export const FEASIBLE_LINE =
  "This can be verified as a program that reads a file and prints a result.";

export const hiddenLine = (n: number): string =>
  `${n} more cases stay hidden from the worker; the verifier keeps them.`;

/** MOCK DATA (?mock=1): canned drafts by keyword; null means "cannot be tested". */
export function mockDraft(request: string): Draft | null {
  if (/snake/i.test(request))
    return draftSchema.parse({
      feasibility: "reframe",
      reason: "A game is played by a person, so no program can pass or fail it.",
      reframe:
        "A game cannot be checked by a test. What can be checked is its rules: a program that reads a list of moves and prints the final score.",
      title: "Score a snake game from its moves",
      description: "Read a file of moves (one per line) and print the final score.",
      entry: "main.py",
      input_ext: "txt",
      visible: [
        { input: "R\nR\nD\n", expected: "0" },
        { input: "R\nEAT\nR\n", expected: "1" },
        { input: "EAT\nEAT\n", expected: "2" },
      ],
      hidden: Array.from({ length: 5 }, (_, i) => ({
        input: `EAT\n`.repeat(i + 3),
        expected: `${i + 3}`,
      })),
      assertions: ["The output is a single whole number.", "The program exits with code 0."],
    });
  if (/sum/i.test(request))
    return draftSchema.parse({
      feasibility: "cli",
      reason: "Reading numbers and printing their sum is checkable.",
      title: "Sum two numbers",
      description: "Read a file with two numbers separated by a space and print their sum.",
      entry: "main.py",
      input_ext: "txt",
      visible: [
        { input: "1 2", expected: "3" },
        { input: "10 -4", expected: "6" },
        { input: "0 0", expected: "0" },
      ],
      hidden: Array.from({ length: 5 }, (_, i) => ({
        input: `${i + 7} ${i + 11}`,
        expected: `${2 * i + 18}`,
      })),
      assertions: ["The output is one number and nothing else.", "The program exits with code 0."],
    });
  return null;
}
