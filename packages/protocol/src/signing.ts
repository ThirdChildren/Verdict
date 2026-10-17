import sodium from "libsodium-wrappers";
import { base64ToBytes, bytesToBase64, bytesToHex, hexToBytes, utf8ToBytes } from "./bytes.js";
import { signingString } from "./canonical.js";

export type SignatureScheme = "eip191" | "ed25519";

/**
 * Scope: the verifier verifies only the signed Task Contract and the delivery. The capability chain
 * (eip191 signatures) is verified by capability-engine. Implementations live elsewhere (WDK EVM adapter in packages/wallet). */
export interface Signer {
  scheme: SignatureScheme;
  publicId: string;
  sign(msg: string): Promise<string>;
}

export type SchemeVerifier = (
  publicId: string,
  message: string,
  sig: string,
) => boolean | Promise<boolean>;

const verifiers = new Map<SignatureScheme, SchemeVerifier>();

/** Plug in a verifier for a scheme the protocol package cannot implement itself (eip191 needs secp256k1 recovery). */
export function registerSchemeVerifier(scheme: SignatureScheme, fn: SchemeVerifier): void {
  verifiers.set(scheme, fn);
}

export function parsePublicId(id: string): { scheme: SignatureScheme; key: string } {
  const i = id.indexOf(":");
  const scheme = id.slice(0, i);
  if (i < 0 || (scheme !== "eip191" && scheme !== "ed25519"))
    throw new Error(`Unknown public id scheme in "${id}"`);
  return { scheme, key: id.slice(i + 1) };
}

async function verifyEd25519(publicId: string, message: string, sig: string): Promise<boolean> {
  if (!/^ed25519:[0-9a-f]{64}$/.test(publicId) || !/^[0-9a-f]{128}$/.test(sig)) return false;
  await sodium.ready;
  return sodium.crypto_sign_verify_detached(
    hexToBytes(sig),
    utf8ToBytes(message),
    hexToBytes(publicId.slice("ed25519:".length)),
  );
}

/** Fails closed: any error, unknown scheme, scheme/publicId mismatch or missing verifier gives false. */
export async function verifySignature(
  scheme: SignatureScheme,
  publicId: string,
  message: string,
  sig: string,
): Promise<boolean> {
  try {
    if (!publicId.startsWith(`${scheme}:`)) return false;
    if (scheme === "ed25519") return await verifyEd25519(publicId, message, sig);
    const fn = verifiers.get(scheme);
    return fn ? (await fn(publicId, message, sig)) === true : false;
  } catch {
    return false;
  }
}

/** Sign `signingString(type, payload)`. */
export function signPayload(
  signer: Signer,
  type: string,
  payload: Record<string, unknown>,
): Promise<string> {
  return signer.sign(signingString(type, payload));
}

/** Verify a signature over `signingString(type, payload)`; scheme comes from the public id. */
export async function verifyPayload(
  type: string,
  payload: Record<string, unknown>,
  publicId: string,
  sig: string,
): Promise<boolean> {
  try {
    return await verifySignature(
      parsePublicId(publicId).scheme,
      publicId,
      signingString(type, payload),
      sig,
    );
  } catch {
    return false;
  }
}

/** Ed25519 signer from a 32-byte seed. */
export async function createEd25519Signer(seed: Uint8Array): Promise<Signer> {
  await sodium.ready;
  const kp = sodium.crypto_sign_seed_keypair(seed);
  return {
    scheme: "ed25519",
    publicId: `ed25519:${bytesToHex(kp.publicKey)}`,
    sign: async (msg) => bytesToHex(sodium.crypto_sign_detached(utf8ToBytes(msg), kp.privateKey)),
  };
}

/**
 * Sealed box (ADR-007) to the Verifier's key: its Ed25519 public id is converted to X25519. Returns base64 (108 chars).
 * Threat model (MVP only): the Verifier uses ONE Ed25519 key to sign verdicts and, converted to X25519,
 * to open sealed preimages. A key compromise therefore exposes both. Acceptable for the hackathon; use separate keys later. */
export async function sealPreimage(preimageHex: string, verifierPublicId: string): Promise<string> {
  await sodium.ready;
  if (!/^[0-9a-f]{64}$/.test(preimageHex)) throw new Error("preimage must be 32 bytes hex");
  const { scheme, key } = parsePublicId(verifierPublicId);
  if (scheme !== "ed25519") throw new Error("verifier must use ed25519");
  const pk = sodium.crypto_sign_ed25519_pk_to_curve25519(hexToBytes(key));
  return bytesToBase64(sodium.crypto_box_seal(hexToBytes(preimageHex), pk));
}

/** Verifier side: open with the Ed25519 seed keypair material (seed). Returns preimage hex. */
export async function openPreimage(sealedB64: string, verifierSeed: Uint8Array): Promise<string> {
  await sodium.ready;
  const kp = sodium.crypto_sign_seed_keypair(verifierSeed);
  const pk = sodium.crypto_sign_ed25519_pk_to_curve25519(kp.publicKey);
  const sk = sodium.crypto_sign_ed25519_sk_to_curve25519(kp.privateKey);
  const out = sodium.crypto_box_seal_open(base64ToBytes(sealedB64), pk, sk);
  return bytesToHex(out);
}
