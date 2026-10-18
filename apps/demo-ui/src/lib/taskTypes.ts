import { z } from "zod";

/** A kind of work the verifier can check, as the engine lists it (GET /api/task-types). */
export interface TaskType {
  id: string;
  /** Short human label; the id when an older engine sends none. */
  title: string;
  description: string;
  format: number;
}

/** What the engine lists on a branch without the endpoint (404): the one package that has always existed. */
export const DEFAULT_TASK_TYPES: TaskType[] = [
  {
    id: "csv2json-v1",
    title: "Convert CSV to JSON",
    description: "Convert a CSV file into a JSON array of objects (all values as strings).",
    format: 1,
  },
];

const entry = z
  .object({
    id: z.string().min(1),
    title: z.string().optional(),
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
    ? list.map((t) => ({
        id: t.id,
        title: t.title?.trim() || t.id,
        description: t.description,
        format: t.format,
      }))
    : null;
}

/** The catalogue plus what the engine says about its verifier; both verifier fields may be absent (older engine). */
export interface TaskTypeCatalogue {
  types: TaskType[];
  verifierReachable?: boolean;
  verifierUrl?: string;
}

/** Reads `verifier_reachable` and `verifier_url` from a task-types answer; absent or mistyped fields are left out. */
export function parseVerifierInfo(raw: unknown): {
  verifierReachable?: boolean;
  verifierUrl?: string;
} {
  if (typeof raw !== "object" || raw === null) return {};
  const o = raw as Record<string, unknown>;
  return {
    ...(typeof o.verifier_reachable === "boolean"
      ? { verifierReachable: o.verifier_reachable }
      : {}),
    ...(typeof o.verifier_url === "string" && o.verifier_url !== ""
      ? { verifierUrl: o.verifier_url }
      : {}),
  };
}

/** Host part of a verifier URL for display; the raw text when it is not a URL. */
export function verifierHost(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

/** A refusal code the engine or the buyer agent sends when a request cannot be verified. */
export const isUnverifiable = (code: string): boolean =>
  code === "TASK_NOT_VERIFIABLE" || code === "TASK_TYPE_UNVERIFIABLE";

/** MOCK DATA (?mock=1): two task types. */
export const MOCK_TASK_TYPES: TaskType[] = [
  ...DEFAULT_TASK_TYPES,
  {
    id: "json-normalise-v1",
    title: "Normalise a JSON document",
    description: "Rewrite a JSON document with sorted keys and 2-space indentation.",
    format: 2,
  },
];
