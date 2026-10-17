import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, normalize, sep } from "node:path";
import { dirHash } from "@verdict/protocol";

export interface DeliveryFile {
  path: string;
  content: string;
}
export interface StoredDelivery {
  dir: string;
  /** Directory hash (ARCHITECTURE 3.3) of the delivery files. */
  dirHash: string;
}

/** Writes a delivery under <root>/<task_id>/attempt-<n>/ and returns its directory hash. Rejects paths that escape it. */
export function storeDelivery(
  root: string,
  taskId: string,
  attempt: number,
  files: readonly DeliveryFile[],
): StoredDelivery {
  const dir = join(root, taskId, `attempt-${attempt}`);
  mkdirSync(dir, { recursive: true });
  for (const f of files) {
    const rel = normalize(f.path);
    if (rel.startsWith("..") || rel.startsWith(sep) || rel.includes(`..${sep}`))
      throw new Error(`delivery path escapes its directory: ${f.path}`);
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, f.content);
  }
  return {
    dir,
    dirHash: dirHash(
      files.map((f) => ({ path: f.path, bytes: new TextEncoder().encode(f.content) })),
    ),
  };
}

/** The delivery directory as a tar.gz, base64 (the DELIVER bundle). Paths are relative to the directory. */
export function bundleDelivery(dir: string): string {
  const r = spawnSync("tar", ["-czf", "-", "-C", dir, "."], {
    maxBuffer: 16 * 1024 * 1024,
  });
  if (r.status !== 0 || !r.stdout) throw new Error("could not bundle the delivery");
  return r.stdout.toString("base64");
}
