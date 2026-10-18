import { z } from "zod";

/** A kind of work the verifier can check, as the engine lists it (GET /api/task-types). */
export interface TaskType {
  id: string;
  description: string;
  format: number;
}

/** What the engine lists on a branch without the endpoint (404): the one package that has always existed. */
export const DEFAULT_TASK_TYPES: TaskType[] = [
  {
    id: "csv2json-v1",
    description: "Convert a CSV file into a JSON array of objects (all values as strings).",
    format: 1,
  },
];

const entry = z
  .object({
    id: z.string().min(1),
    description: z.string().default(""),
    format: z.number().default(1),
  })
  .passthrough();
// The list is `task_types`; the first engine draft named it `types`. Both are read.
const listSchema = z
  .object({ task_types: z.array(entry).optional(), types: z.array(entry).optional() })
  .passthrough();

/** Reads a task-type list; null when the answer has neither field. Never throws. */
export function parseTaskTypes(raw: unknown): TaskType[] | null {
  const r = listSchema.safeParse(raw);
  if (!r.success) return null;
  const list = r.data.task_types ?? r.data.types;
  return list
    ? list.map((t) => ({ id: t.id, description: t.description, format: t.format }))
    : null;
}

/** A refusal code the engine or the buyer agent sends when a request cannot be verified. */
export const isUnverifiable = (code: string): boolean =>
  code === "TASK_NOT_VERIFIABLE" || code === "TASK_TYPE_UNVERIFIABLE";

/** MOCK DATA (?mock=1): two task types. */
export const MOCK_TASK_TYPES: TaskType[] = [
  ...DEFAULT_TASK_TYPES,
  {
    id: "json-normalise-v1",
    description: "Rewrite a JSON document with sorted keys and 2-space indentation.",
    format: 2,
  },
];
