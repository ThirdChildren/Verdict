import { z } from "zod";

const workerBase = () => {
  const q = new URLSearchParams(location.search).get("worker");
  const env = import.meta.env;
  return `${location.protocol}//${q ?? `${env.VITE_ENGINE_HOST ?? location.hostname}:${env.VITE_WORKER_PORT ?? "7405"}`}`;
};

export const workerStreamUrl = () => `${workerBase().replace(/^http/, "ws")}/v0/events`;

const attemptSchema = z.object({
  n: z.number(),
  seconds: z.number(),
  tokens_per_sec: z.number().nullable(),
  self_check: z.enum(["PASS", "FAIL", "WITHHOLD", "not run"]),
});
const taskSchema = z
  .object({
    taskId: z.string(),
    state: z.string(),
    progress: z.object({ attempt: z.number(), max_attempts: z.number() }).optional(),
    attempts: z.array(attemptSchema).optional(),
    sabotaged: z.boolean().optional(),
    /** Switches as the worker itself recorded them when this task started. */
    toggles: z.object({ sabotaged: z.boolean(), disappears: z.boolean() }).optional(),
  })
  .passthrough();
export type WorkerTaskView = z.infer<typeof taskSchema>;

export async function fetchWorkerTasks(): Promise<WorkerTaskView[]> {
  const r = await fetch(`${workerBase()}/v0/tasks`);
  if (!r.ok) throw new Error("worker not reachable");
  return z.object({ tasks: z.array(taskSchema) }).parse(await r.json()).tasks;
}

const configSchema = z.object({ sabotaged: z.boolean(), disappears: z.boolean().optional() });
export type WorkerConfig = z.infer<typeof configSchema>;

export async function fetchWorkerConfig(): Promise<WorkerConfig> {
  const r = await fetch(`${workerBase()}/v0/config`);
  if (!r.ok) throw new Error("worker not reachable");
  return configSchema.parse(await r.json());
}

/** Demo switches: "sabotaged" (broken file on purpose) and "disappears" (neither claims nor cancels). */
export async function setWorkerConfig(change: Partial<WorkerConfig>): Promise<WorkerConfig> {
  const r = await fetch(`${workerBase()}/v0/config`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(change),
  });
  if (!r.ok) throw new Error("The worker did not accept the change.");
  return configSchema.parse(await r.json());
}

/** The files of a delivery, or null when the worker has none (or is unreachable). */
export async function fetchWorkerDelivery(
  taskId: string,
): Promise<{ path: string; content: string }[] | null> {
  try {
    const r = await fetch(`${workerBase()}/v0/tasks/${encodeURIComponent(taskId)}/delivery`);
    if (!r.ok) return null;
    const j = z
      .object({ files: z.array(z.object({ path: z.string(), content: z.string() })) })
      .parse(await r.json());
    return j.files;
  } catch {
    return null;
  }
}
