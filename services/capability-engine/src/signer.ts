import WalletManagerEvm from "@tetherto/wdk-wallet-evm";
import type { Signer } from "@verdict/protocol";
import { eip191SignerFromAccount } from "@verdict/wallet";

/** eip191 signer for a role seed (WDK account 0). The seed never leaves this call. */
export async function eip191SignerFromSeed(seed: Uint8Array): Promise<Signer> {
  const wallet = new WalletManagerEvm(seed, {});
  const account = await wallet.getAccount(0);
  return eip191SignerFromAccount(account);
}
