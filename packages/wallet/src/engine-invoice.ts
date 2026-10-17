import type { DecodedInvoice as WalletDecodedInvoice } from "./port.js";
import type { DecodedInvoice } from "./types.js";

/** Maps the wallet's decoded invoice to the engine shape. Fails closed on a non-RGB invoice. */
export function toEngineInvoice(d: WalletDecodedInvoice, now: Date = new Date()): DecodedInvoice {
  if (d.assetId === null || d.assetAmount === null)
    throw new Error("Invoice carries no RGB asset; refusing to treat it as a tUSD invoice.");
  return {
    payment_hash: d.paymentHash,
    amount: d.assetAmount,
    asset_id: d.assetId,
    payee_node_id: d.payeeNodeId,
    min_final_cltv_expiry_delta: d.minFinalCltvExpiryDelta,
    expiry_sec: Math.max(0, Math.floor((Date.parse(d.expiresAt) - now.getTime()) / 1000)),
  };
}
