import { bytesToHex } from "./bytes.js";

/** CSPRNG bytes via the Web Crypto API (Node 24 and browsers). */
export function randomBytes(n: number): Uint8Array {
  if (!Number.isInteger(n) || n < 0 || n > 65536) throw new Error("Invalid random length");
  return globalThis.crypto.getRandomValues(new Uint8Array(n));
}

/** 32 random bytes as lowercase hex (e.g. the preimage P). Never log the result when it is a secret. */
export function randomHex32(): string {
  return bytesToHex(randomBytes(32));
}
