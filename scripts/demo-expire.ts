// pnpm demo:expire [-- <payment_hash>]
// The demo's "worker disappeared" scene: mines regtest blocks one at a time until the buyer's payment is reported Failed
// (the HTLC timed out and the funds came back), capped at 200 blocks. The engine then moves the reservation to released.
import { fileURLToPath } from "node:url";
import { WalletClient } from "../packages/wallet/src/index.js";
import { mineUntilFailed } from "../services/capability-engine/src/demo-mine.js";

export { MAX_BLOCKS, mineUntilFailed } from "../services/capability-engine/src/demo-mine.js";

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let hash = process.argv.slice(2).find((a) => /^[0-9a-f]{64}$/.test(a));
  if (!hash) {
    const r = (await fetch("http://127.0.0.1:7405/v0/tasks").then((x) => x.json())) as {
      tasks: { paymentHash: string }[];
    };
    hash = r.tasks.at(-1)?.paymentHash;
  }
  if (!hash) {
    console.error("[demo:expire] no payment hash: pass one, or run a task first");
    process.exit(2);
  }
  const wallet = new WalletClient({
    baseUrl: process.env.WALLET_BUYER_URL ?? "http://127.0.0.1:7411",
  });
  await wallet.init();
  const r = await mineUntilFailed(wallet, hash, { log: (m) => console.log(`[demo:expire] ${m}`) });
  console.log(
    r.failed
      ? `[demo:expire] payment Failed after ${r.blocks} blocks (${r.seconds} s): the buyer's funds are released`
      : `[demo:expire] still held after ${r.blocks} blocks: giving up`,
  );
  await wallet.close();
  process.exit(r.failed ? 0 : 1);
}
