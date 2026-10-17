import type { LlmClient } from "@verdict/llm";
import type { DeliveryFile } from "../store.js";

export interface Generated {
  files: DeliveryFile[];
  model: string;
  /** Wall time of the model call, ms. */
  generationMs: number;
  generatedTokens: number | null;
  tokensPerSec: number | null;
}

/** Produces the deliverable for a task spec. The worker agent never sees the preimage and never signs with it. */
/** Feedback for a retry: the previous attempt and what the local check said about it. */
export interface RetryContext {
  previousCode: string;
  feedback: string;
}

/** Live model output for the UI. Called per token; the caller batches. */
export interface StreamHooks {
  onToken?: (t: string) => void;
  onThinking?: (t: string) => void;
  /** The attempt ended (generated or failed). Stats are the model's own when it reported them. */
  done?: (stats: { tokens: number | null; tokPerSec: number | null } | null) => void;
}

export type Generator = (
  spec: string,
  retry?: RetryContext,
  hooks?: StreamHooks,
) => Promise<Generated>;

// The task text states exactly what the automatic test checks (not the test files themselves), so the model is
// never judged on a detail it was not told. Diagnosed in P3.2c: 4 of 5 failures were "split on newlines first".
const SYSTEM = `You are a careful JavaScript engineer. You write exactly one file: csv2json.mjs, a zero-dependency Node.js ESM command line tool.
Usage: node csv2json.mjs <input.csv>. It prints the CSV as a JSON array of objects to stdout.

Output format:
- Exactly one JSON document on stdout: JSON.stringify(rows, null, 2) followed by a newline. Nothing else on stdout. Exit code 0.
- The first row is the header. Every later row becomes one object whose keys follow the header order. All values are strings (never numbers); an empty cell is "".
- A file with only a header prints [].
Example: the input "name,age\\nalice,30\\nbob,25\\n" prints [{"name":"alice","age":"30"},{"name":"bob","age":"25"}] (indented with 2 spaces).

The automatic test runs your tool on six CSV files and compares the JSON with the expected one, key order included. It checks:
1. A plain file with a header and two rows.
2. Quoted fields: a comma inside quotes stays in the value; a doubled quote ("") inside quotes is one quote character; a quoted field may contain a LINE BREAK, which stays in the value as \\n.
3. CRLF line endings (\\r\\n): the \\r is never part of a value.
4. UTF-8 text with accents and non-Latin letters and an emoji, kept as is.
5. Empty cells, including a row made only of empty cells (",,").
6. A file with only a header.
It also checks that the output validates as an array of objects with string values, and that the code imports nothing network- or process-related (no net, http, https, tls, dgram, dns, child_process, worker_threads, no fetch, no dynamic import() or require()).

How to parse (this is where attempts usually fail): do NOT split the text into lines first and do NOT split on commas first. Read the whole file with node:fs readFileSync(path, "utf8") and walk it character by character with this state machine. State: rows (array of arrays), row (current array), field (current string), inQuotes (boolean).
- inQuotes and the character is '"': if the next character is also '"', add one '"' to field and skip both; otherwise inQuotes = false.
- inQuotes and any other character (comma, line break, anything): add it to field unchanged.
- not inQuotes and the character is '"': inQuotes = true.
- not inQuotes and ',': push field to row, field = "".
- not inQuotes and '\\r': ignore it.
- not inQuotes and '\\n': push field to row, push row to rows, row = [], field = "".
- any other character: add it to field.
At the end of the text, if field is not empty or row is not empty, push field and row the same way (so a missing final line break still works and a final line break adds no extra row).
Reference loop for these rules (use it as it is; declare rows, row, field with let, not const):
let rows = [], row = [], field = "", inQuotes = false;
for (let i = 0; i < text.length; i++) {
  const c = text[i];
  if (inQuotes) {
    if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false; }
    else field += c;
  } else if (c === '"') inQuotes = true;
  else if (c === ",") { row.push(field); field = ""; }
  else if (c === "\\r") { /* ignored */ }
  else if (c === "\\n") { row.push(field); rows.push(row); row = []; field = ""; }
  else field += c;
}
if (field !== "" || row.length > 0) { row.push(field); rows.push(row); }
Then rows[0] is the header and every other row is zipped with it: object[header[i]] = row[i] ?? "". A header-only file gives [].
Think briefly. Reply with the complete file in one fenced code block and nothing else.`;

/** Strips thinking leftovers and the markdown fence the 9B model wraps around its code (SDK_NOTES P0.2b). */
export function extractCode(text: string): string {
  const withoutThink = text.replace(/<think>[\s\S]*?<\/think>/g, "");
  const fenced = withoutThink.match(/```[a-zA-Z]*\n([\s\S]*?)```/);
  const code = (fenced?.[1] ?? withoutThink).trim();
  return `${code}\n`;
}

/** The model spent its whole budget thinking and wrote no file. A retryable failure, not a crash. */
export class NoCodeError extends Error {
  constructor() {
    super("the model returned no code");
    this.name = "NoCodeError";
  }
}

/** Per-attempt token cap. Measured in P3.3 step 0 (see playbook). */
export const DEFAULT_MAX_TOKENS = 4000;

export function llmGenerator(llm: LlmClient, maxTokens = DEFAULT_MAX_TOKENS): Generator {
  return async (spec, retry, hooks) => {
    const r = await llm.generateText(
      [
        { role: "system", content: SYSTEM },
        { role: "user", content: `Task: ${spec}` },
        ...(retry
          ? [
              {
                role: "assistant" as const,
                content: `\`\`\`javascript\n${retry.previousCode}\`\`\``,
              },
              {
                role: "user" as const,
                content: `The automatic test rejected that file:\n${retry.feedback}\nFind the bug in at most a few lines of reasoning, then reply with the complete corrected file in one fenced code block.`,
              },
            ]
          : []),
      ],
      {
        maxTokens,
        ...(hooks?.onToken ? { onToken: hooks.onToken } : {}),
        ...(hooks?.onThinking ? { onThinking: hooks.onThinking } : {}),
      },
    );
    const code = extractCode(r.text);
    if (code.trim().length < 20) throw new NoCodeError();
    return {
      files: [{ path: "csv2json.mjs", content: code }],
      model: llm.modelName,
      generationMs: r.stats.wallMs,
      generatedTokens: r.stats.generatedTokens,
      tokensPerSec: r.stats.tokensPerSec,
    };
  };
}
