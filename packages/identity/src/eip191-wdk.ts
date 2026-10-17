import WalletManagerEvm, { WalletAccountReadOnlyEvm } from "@tetherto/wdk-wallet-evm";
import { registerSchemeVerifier } from "@verdict/protocol";
import { markEip191Registered } from "./eip191.js";

const PUBLIC_ID = /^eip191:(0x[0-9a-f]{40})$/;

/**
 * Pure recover-and-compare verifier backed by WDK's seedless read-only EVM account (P0.4).
 * No seed, no node. Fails closed on any error.
 */
export async function verifyEip191WithWdk(
  publicId: string,
  message: string,
  sig: string,
): Promise<boolean> {
  const m = PUBLIC_ID.exec(publicId);
  if (!m) return false;
  try {
    return (await new WalletAccountReadOnlyEvm(m[1] as string, {}).verify(message, sig)) === true;
  } catch {
    return false;
  }
}

/** Registers the WDK-backed eip191 verifier. Call once at startup in every service that checks signatures. */
export function registerWdkEip191Verifier(): void {
  registerSchemeVerifier("eip191", verifyEip191WithWdk);
  markEip191Registered();
}

/** Lowercase 0x address of account 0 for a role's 32-byte seed (WDK raw BIP-32 master seed). */
export async function eip191AddressFromSeed(seed: Uint8Array): Promise<string> {
  const wallet = new WalletManagerEvm(seed, {});
  try {
    return (await (await wallet.getAccount(0)).getAddress()).toLowerCase();
  } finally {
    wallet.dispose();
  }
}
