import { z } from "zod";

export const hex32 = z.string().regex(/^[0-9a-f]{64}$/, "expected 64 lowercase hex chars");
export const sha256HexSchema = hex32;
export const isoUtc = z.iso.datetime();
/** Decimal string with at least one fraction digit; exact precision is enforced by parseAmount. */
export const amountString = z
  .string()
  .regex(
    /^(0|[1-9][0-9]*)\.[0-9]{1,18}$/,
    "expected a decimal string like 1.20 (1 to 18 fraction digits)",
  );
export const positiveAmountString = amountString.refine(
  (s) => /[1-9]/.test(s),
  "amount must be greater than zero",
);

/** `eip191:0x<40 lowercase hex>` (WDK EVM address) or `ed25519:<64 lowercase hex>`. */
export const publicId = z
  .string()
  .regex(
    /^(eip191:0x[0-9a-f]{40}|ed25519:[0-9a-f]{64})$/,
    "expected eip191:0x… or ed25519:… public id",
  );
export type PublicId = z.infer<typeof publicId>;

/** Lowercase hex: EIP-191 signature (0x + 65 bytes) or Ed25519 signature (64 bytes). */
export const signatureString = z
  .string()
  .regex(/^(0x[0-9a-f]{130}|[0-9a-f]{128})$/, "expected a signature");

export const assetId = z.string().regex(/^rgb:[A-Za-z0-9_\-:.~]+$/, "expected rgb:… asset id");
/** Compressed secp256k1 Lightning node pubkey. */
export const lnNodeId = z
  .string()
  .regex(/^0[23][0-9a-f]{64}$/, "expected 33-byte compressed pubkey hex");
export const paymentHash = hex32;
export const preimageHex = hex32;
export const capIdSchema = z.string().regex(/^cap_[0-9a-f]{16}$/);
export const taskIdSchema = z.string().regex(/^task_[0-9a-f]{16}$/);
export const category = z.string().min(1).max(64);
export const action = z.string().min(1).max(64);
