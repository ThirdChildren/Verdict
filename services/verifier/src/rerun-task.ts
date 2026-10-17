// Re-run the verifier package on a task's delivery, fetched from the worker (GET /v0/tasks/:id/delivery).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { dirHashFromDisk } from "@verdict/protocol/node";
import { runVerification } from "./runner.js";

export const TASK_ID_RE = /^task_[0-9a-f]{16}$/;

export interface RerunReport {
  outcome: "PASS" | "FAIL" | "WITHHOLD";
  lines: string[];
}

export class RerunError extends Error {}

async function fetchDelivery(
  workerUrl: string,
  taskId: string,
  fetchFn: typeof fetch,
): Promise<{ path: string; content: string }[]> {
  let res: Response;
  try {
    res = await fetchFn(`${workerUrl}/v0/tasks/${taskId}/delivery`, {
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new RerunError(`Could not reach the worker at ${workerUrl}. Is it running?`);
  }
  if (res.status === 404)
    throw new RerunError(
      `The worker has no delivery for ${taskId}. Check the id on the Proof tab.`,
    );
  if (!res.ok)
    throw new RerunError(`The worker refused to serve the delivery (HTTP ${res.status}).`);
  const body: unknown = await res.json().catch(() => null);
  const files = (body as { files?: unknown } | null)?.files;
  if (
    !Array.isArray(files) ||
    !files.every(
      (f) =>
        f && typeof f === "object" && typeof f.path === "string" && typeof f.content === "string",
    )
  )
    throw new RerunError("The worker returned a delivery in an unexpected format.");
  return files as { path: string; content: string }[];
}

/** Fails closed: every problem throws RerunError or yields FAIL/WITHHOLD, never PASS. */
export async function rerunTask(opts: {
  taskId: string;
  workerUrl: string;
  packageDir: string;
  fetchFn?: typeof fetch;
}): Promise<RerunReport> {
  if (!TASK_ID_RE.test(opts.taskId))
    throw new RerunError(
      `"${opts.taskId}" is not a task id (expected task_ followed by 16 hex characters).`,
    );
  const files = await fetchDelivery(opts.workerUrl, opts.taskId, opts.fetchFn ?? fetch);
  const tmp = mkdtempSync(join(tmpdir(), "verifier-rerun-"));
  try {
    const dest = join(tmp, "delivery");
    mkdirSync(dest);
    for (const f of files) {
      const abs = resolve(dest, f.path);
      if (!abs.startsWith(dest + sep))
        throw new RerunError("The delivery contains a path outside its folder.");
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, f.content);
    }
    const r = await runVerification({
      packageDir: opts.packageDir,
      deliveryDir: dest,
      maxVerifySeconds: 60,
    });
    const lines = [
      `Package hash   ${await dirHashFromDisk(opts.packageDir)}`,
      `Delivery hash  ${await dirHashFromDisk(dest)}`,
      `Sandbox        ${r.sandbox}`,
      ...r.checks.map((c) => `Check          ${c.id}: ${c.status}`),
      `Result         ${r.outcome} (exit code ${r.exitCode ?? "none"})${r.code ? ` ${r.code}` : ""} ${r.message}`,
    ];
    return { outcome: r.outcome, lines };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
