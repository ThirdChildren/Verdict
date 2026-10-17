import { sha256 } from "@noble/hashes/sha2.js";
import canonicalize from "canonicalize";
import { bytesToHex, utf8ToBytes } from "./bytes.js";

/** RFC 8785 JCS string. Throws on values JSON cannot represent. */
export function canonical(obj: unknown): string {
  const s = canonicalize(obj);
  if (s === undefined) throw new Error("Value is not canonicalizable");
  return s;
}

export function sha256Hex(data: string | Uint8Array): string {
  return bytesToHex(sha256(typeof data === "string" ? utf8ToBytes(data) : data));
}

/** lowercase hex sha256(utf8(canonical(obj))). Hashes the object exactly as given. */
export function hashObj(obj: unknown): string {
  return sha256Hex(canonical(obj));
}

/** Top-level fields that never cover themselves. */
export const SIGNATURE_FIELDS = ["signature", "signatures", "sig", "verifier_sig"] as const;

export function stripSignatures<T extends Record<string, unknown>>(
  obj: T,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...obj };
  for (const f of SIGNATURE_FIELDS) delete out[f];
  return out;
}

/** hashObj of the object with signature fields removed (what signatures cover). */
export function hashUnsigned(obj: Record<string, unknown>): string {
  return hashObj(stripSignatures(obj));
}

/** `verdict:v0:<TYPE>:<hashObj(unsigned payload)>` (domain separation). */
export function signingString(type: string, payload: Record<string, unknown>): string {
  if (!/^[A-Z][A-Z0-9_]*$/.test(type)) throw new Error(`Invalid signing type "${type}"`);
  return `verdict:v0:${type}:${hashUnsigned(payload)}`;
}
