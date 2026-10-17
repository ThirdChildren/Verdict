import { readFileSync } from "node:fs";
import { join } from "node:path";
import { hexToBytes, publicId } from "@verdict/protocol";
import { z } from "zod";

/** Public ids written by `keys:init` to $VERDICT_DATA_DIR/identities.json. */
export const identitiesSchema = z
  .object({
    principal: publicId,
    engine: publicId,
    buyer: publicId,
    worker: publicId,
    verifier: publicId,
  })
  .passthrough();
export type Identities = z.infer<typeof identitiesSchema>;

export function loadIdentities(dataDir: string): Identities {
  const file = join(dataDir, "identities.json");
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`Cannot read ${file} (run keys:init first): ${String(err)}`);
  }
  const parsed = identitiesSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`Invalid ${file}: ${parsed.error.message}`);
  return parsed.data;
}

/** Name -> public id of every worker-role identity (keys starting with "worker"). Principal, engine and verifier are never payees. */
export type WorkerDirectory = Readonly<Record<string, string>>;

export function workerDirectory(ids: Record<string, unknown>): WorkerDirectory {
  const out: Record<string, string> = {};
  for (const [name, id] of Object.entries(ids)) {
    if (/^worker/.test(name) && publicId.safeParse(id).success)
      out[name.toLowerCase()] = id as string;
  }
  return out;
}

/** The buyer's own 32-byte seed. This is the ONLY secret the buyer-agent process reads (invariant 1). */
export function loadBuyerSeed(dataDir: string): Uint8Array {
  const file = join(dataDir, "keys", "buyer.key");
  let hex: string;
  try {
    hex = readFileSync(file, "utf8").trim();
  } catch {
    throw new Error(`Cannot read ${file} (run keys:init first)`);
  }
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error(`${file} is malformed`);
  return hexToBytes(hex);
}
