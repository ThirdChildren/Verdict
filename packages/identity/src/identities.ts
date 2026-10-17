// Public identities for the five roles. Secrets live in $VERDICT_DATA_DIR/keys/<role>.key (0600), never here.
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { bytesToHex, createEd25519Signer, hexToBytes } from "@verdict/protocol";
import { resolveDataDir } from "./data-dir.js";
import { eip191AddressFromSeed } from "./eip191-wdk.js";

export const ROLES = ["principal", "engine", "buyer", "worker", "verifier"] as const;
export type Role = (typeof ROLES)[number];
export type Identities = Record<Role, string>;

export const dataDir = resolveDataDir;

const isPublicId = (v: unknown): v is string =>
  typeof v === "string" && /^(eip191:0x[0-9a-f]{40}|ed25519:[0-9a-f]{64})$/.test(v);

/** Reads identities.json (public ids only). Throws a plain-language error if missing or malformed. */
export function loadIdentities(dir: string = dataDir()): Identities {
  const p = join(dir, "identities.json");
  if (!existsSync(p)) throw new Error(`No identities at ${p}. Run: pnpm keys:init`);
  const raw = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
  const out = {} as Identities;
  for (const r of ROLES) {
    const v = raw[r];
    if (!isPublicId(v))
      throw new Error(`identities.json: "${r}" is missing or not a valid public id`);
    out[r] = v;
  }
  return out;
}

/** Reads a role's 32-byte secret seed (hex) from its 0600 file. Never log the result. */
export function loadSecretSeed(role: Role, dir: string = dataDir()): Uint8Array {
  const hex = readFileSync(join(dir, "keys", `${role}.key`), "utf8").trim();
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error(`keys/${role}.key is malformed`);
  return hexToBytes(hex);
}

export interface InitResult {
  identities: Identities;
  created: Role[];
  notes: string[];
}

/** Idempotent: existing key files are kept; identities.json is rewritten from them. Never returns secrets. */
export async function initIdentities(dir: string = dataDir()): Promise<InitResult> {
  const keys = join(dir, "keys");
  mkdirSync(keys, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700); // L3: the data dir is owner-only
  const notes: string[] = [];
  const created: Role[] = [];
  const identities = {} as Identities;
  for (const role of ROLES) {
    const f = join(keys, `${role}.key`);
    if (!existsSync(f)) {
      writeFileSync(f, bytesToHex(randomBytes(32)), { mode: 0o600 });
      created.push(role);
    }
    chmodSync(f, 0o600);
    const hex = readFileSync(f, "utf8").trim();
    if (role !== "verifier" && role !== "buyer")
      identities[role] = `eip191:${await eip191AddressFromSeed(hexToBytes(hex))}`;
    else identities[role] = (await createEd25519Signer(hexToBytes(hex))).publicId;
  }
  writeFileSync(join(dir, "identities.json"), `${JSON.stringify(identities, null, 2)}\n`, {
    mode: 0o644,
  });
  return { identities, created, notes };
}
