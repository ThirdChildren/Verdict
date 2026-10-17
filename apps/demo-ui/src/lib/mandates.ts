import { z } from "zod";

/** One mandate as the screen keeps it. Rows made from live events alone have empty figures until the API fills them. */
export interface MandateFigures {
  paid: string;
  locked: string;
  left: string;
}
export interface MandateCounts {
  total: number;
  settled: number;
  refunded: number;
  blocked: number;
  in_flight: number;
}
export type MandateStatus = "active" | "retired" | "expired";
export interface MandateRow {
  /** Root capability hash (the key). */
  hash: string;
  cap_id: string;
  status: MandateStatus;
  ceiling: string;
  per_task: string;
  expires_at: string;
  created_at: string | null;
  retired_at: string | null;
  /** Frozen for a retired mandate (as the engine reported them). Live mandates show the budget events instead. */
  figures: MandateFigures | null;
  tasks: MandateCounts | null;
  /** 1-based registration order (01 = oldest). Screen-only. */
  order: number;
}

const decimal = z.string().regex(/^\d+(\.\d+)?$/);
const apiRow = z.object({
  cap_id: z.string(),
  hash: z.string().min(1),
  status: z.enum(["active", "retired", "expired"]),
  ceiling: decimal,
  per_task: decimal,
  expires_at: z.string(),
  created_at: z.string().nullish(),
  retired_at: z.string().nullish(),
  figures: z.object({ paid: decimal, locked: decimal, left: decimal }),
  tasks: z.object({
    total: z.number(),
    settled: z.number(),
    refunded: z.number(),
    blocked: z.number(),
    in_flight: z.number(),
  }),
});

/** Reads GET /api/mandates (newest first). Unknown fields are ignored; a bad row is skipped with a warning. */
export function parseMandates(json: unknown): MandateRow[] {
  const list = z.object({ mandates: z.array(z.unknown()) }).safeParse(json);
  if (!list.success) {
    console.warn("mandates: unreadable response, ignored");
    return [];
  }
  const rows: MandateRow[] = [];
  const total = list.data.mandates.length;
  list.data.mandates.forEach((raw, i) => {
    const r = apiRow.safeParse(raw);
    if (!r.success) {
      console.warn("mandates: row skipped (missing or invalid field)", r.error.issues[0]?.path);
      return;
    }
    const d = r.data;
    rows.push({
      hash: d.hash,
      cap_id: d.cap_id,
      status: d.status,
      ceiling: d.ceiling,
      per_task: d.per_task,
      expires_at: d.expires_at,
      created_at: d.created_at ?? null,
      retired_at: d.retired_at ?? null,
      figures: d.figures,
      tasks: d.tasks,
      order: total - i,
    });
  });
  return rows;
}

/** Task → mandate links from GET /api/tasks (rows without a usable root_hash are ignored). */
export function parseTaskRoots(json: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  const list = z.object({ tasks: z.array(z.unknown()) }).safeParse(json);
  if (!list.success) return out;
  for (const raw of list.data.tasks) {
    const r = z.object({ task_id: z.string(), root_hash: z.string().min(1) }).safeParse(raw);
    if (r.success) out[r.data.task_id] = r.data.root_hash;
  }
  return out;
}

/** The status to show: a retired mandate stays retired; an active one past its expiry reads expired. */
export function rowStatus(row: MandateRow, now: number): MandateStatus {
  if (row.status === "retired" || row.retired_at) return "retired";
  if (row.status === "expired") return "expired";
  const t = Date.parse(row.expires_at);
  return Number.isFinite(t) && t <= now ? "expired" : "active";
}

export const READ_ONLY_RETIRED =
  "This mandate is retired. Select the active one or create a new mandate.";
export const READ_ONLY_EXPIRED =
  "This mandate has expired. Select the active one or create a new mandate.";

/** Why no task can start under this mandate, or null when it is the live one. */
export function readOnlyReason(row: MandateRow | undefined, now: number): string | null {
  if (!row) return null;
  const st = rowStatus(row, now);
  return st === "retired" ? READ_ONLY_RETIRED : st === "expired" ? READ_ONLY_EXPIRED : null;
}

const clock = (iso: string | null): string => {
  const t = iso ? Date.parse(iso) : Number.NaN;
  return Number.isFinite(t)
    ? new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })
    : "--:--";
};
export const clockHm = clock;
export const clockHms = (iso: string | null): string => {
  const t = iso ? Date.parse(iso) : Number.NaN;
  return Number.isFinite(t) ? new Date(t).toLocaleTimeString([], { hour12: false }) : "--:--:--";
};

export function leftText(expiresAt: string, now: number): string {
  const mins = Math.max(0, Math.floor((Date.parse(expiresAt) - now) / 60000));
  const h = Math.floor(mins / 60);
  return h > 0 ? `${h}h${String(mins % 60).padStart(2, "0")}m left` : `${mins}m left`;
}

export const taskWord = (n: number) => `${n} ${n === 1 ? "task" : "tasks"}`;
