import { registerSchemeVerifier, type SignatureScheme, type Signer } from "@verdict/protocol";

/** `ethers.verifyMessage`-compatible recovery: returns the 0x address that signed the EIP-191 message. */
export type RecoverAddress = (message: string, signature: string) => string;

/**
 * Pure recover-and-compare verifier (no wallet or node). publicId is `eip191:0x<lowercase address>`.
 * `recover` is injected (e.g. `ethers.verifyMessage`, same result as WDK's seedless read-only verify, P0.4).
 * Fails closed on any error.
 */
export function makeEip191Verifier(
  recover: RecoverAddress,
): (publicId: string, message: string, sig: string) => boolean {
  return (publicId, message, sig) => {
    const m = /^eip191:(0x[0-9a-f]{40})$/.exec(publicId);
    if (!m) return false;
    try {
      return recover(message, sig).toLowerCase() === m[1];
    } catch {
      return false;
    }
  };
}

let eip191Registered = false;

/** Registers the "eip191" verifier with @verdict/protocol via registerSchemeVerifier. */
export function registerEip191Verifier(recover: RecoverAddress): void {
  registerSchemeVerifier("eip191", makeEip191Verifier(recover));
  eip191Registered = true;
}

/** For verifiers registered outside this file (eip191-wdk.ts). */
export function markEip191Registered(): void {
  eip191Registered = true;
}

export function isEip191VerifierRegistered(): boolean {
  return eip191Registered;
}

/**
 * Startup guard for every service that checks signed messages. In VERDICT_MODE=demo a missing
 * eip191 verifier would silently reject (or worse, bypass) real signatures, so refuse to start.
 */
export function assertEip191VerifierForMode(env: NodeJS.ProcessEnv = process.env): void {
  if (env.VERDICT_MODE === "demo" && !eip191Registered)
    throw new Error(
      "The eip191 signature verifier is not registered, so signed permissions and contracts cannot be checked. Refusing to start in demo mode.",
    );
}

interface EvmAccountLike {
  sign(message: string): Promise<string>;
  getAddress(): Promise<string>;
}

/** Signer over a WDK EVM account (`@tetherto/wdk-wallet-evm`, not installed yet: the caller passes the account). */
export async function eip191SignerFromAccount(account: EvmAccountLike): Promise<Signer> {
  const addr = (await account.getAddress()).toLowerCase();
  const scheme: SignatureScheme = "eip191";
  return {
    scheme,
    publicId: `eip191:${addr}`,
    sign: async (msg) => (await account.sign(msg)).toLowerCase(),
  };
}
