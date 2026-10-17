/** BLOCK/FAIL catalogue: code -> plain-language template shown verbatim in the UI. */
export const BLOCK_TEMPLATES = {
  MALFORMED_INTENT:
    "The agent's request was not understood ({reason}). Nothing was signed and no funds moved.",
  AMOUNT_EXCEEDS_PER_TASK:
    "The agent asked to pay {amount} tUSD, but your mandate allows at most {max} tUSD per task. Nothing was signed and no funds moved.",
  AMOUNT_EXCEEDS_REMAINING:
    "The agent asked to pay {amount} tUSD, but only {remaining} tUSD is left in your mandate. Nothing was signed and no funds moved.",
  RECURRING_NOT_ALLOWED:
    "The agent asked for a recurring payment, but your mandate allows one-off payments only. Nothing was signed and no funds moved.",
  CATEGORY_NOT_ALLOWED:
    'The agent asked to spend on "{category}", but your mandate only covers: {allowed}. Nothing was signed and no funds moved.',
  ACTION_NOT_ALLOWED:
    'The agent tried the action "{action}", but your mandate only allows: {allowed}. Nothing was signed and no funds moved.',
  COUNTERPARTY_NOT_ALLOWED:
    "The agent tried to pay {counterparty}, who is not on your list of approved workers. Nothing was signed and no funds moved.",
  CAPABILITY_EXPIRED:
    "The permission expired at {expires_at}, so it can no longer be used. Nothing was signed and no funds moved.",
  CAPABILITY_REVOKED:
    "This permission was revoked and can no longer be used. Nothing was signed and no funds moved.",
  MAX_PAYMENTS_REACHED:
    "This permission allows {max} payment(s) and they have all been used. Nothing was signed and no funds moved.",
  PARENT_MISMATCH:
    "The task permission does not match the mandate it claims to come from. Nothing was signed and no funds moved.",
  CHILD_OUTLIVES_PARENT:
    "The task permission would last until {child_expires_at}, longer than the mandate it comes from ({parent_expires_at}). Nothing was signed and no funds moved.",
  PAYEE_NOT_IN_PARENT:
    "The payee {payee} is not on the list of payees the mandate allows, so a task permission cannot include it. Nothing was signed and no funds moved.",
  SIGNATURE_INVALID:
    "A signature on {subject} could not be verified, so it was rejected. Nothing was signed and no funds moved.",
  ASSET_MISMATCH:
    "The payment uses a different asset ({actual}) than the mandate allows ({expected}). Nothing was signed and no funds moved.",
  INVOICE_HASH_MISMATCH:
    "The worker's invoice is locked to a different secret than the signed contract. The payment was refused and no funds moved.",
  INVOICE_AMOUNT_MISMATCH:
    "The worker's invoice asks for {actual} tUSD, but the signed contract says {expected} tUSD. The payment was refused and no funds moved.",
  INVOICE_PAYEE_MISMATCH:
    "The invoice would pay a different recipient than the worker named in the signed contract. The payment was refused and no funds moved.",
  LOCK_WINDOW_TOO_SHORT:
    "The invoice locks funds for only {actual} seconds, but the task needs at least {required} seconds to finish and be checked. The payment was refused and no funds moved.",
  LOCK_WINDOW_TOO_LONG:
    "The invoice would lock funds for {actual} seconds, longer than the {max} seconds the contract allows. The payment was refused and no funds moved.",
  PACKAGE_HASH_MISMATCH:
    "The verifier's checking package differs from the one in the contract, so the escrow was not funded.",
  PREIMAGE_MISMATCH:
    "The secret handed to the verifier does not match the payment lock in the contract, so the escrow was not funded.",
  DELIVERY_HASH_MISMATCH:
    "The delivered files do not match the fingerprint the worker declared, so they were not checked.",
  DELIVERY_REJECTED:
    "The delivery failed verification (check: {check}). The worker may try again until the deadline; no payment was released.",
  VERIFIER_TIMEOUT:
    "The verifier did not finish within {seconds} seconds, so the delivery counts as failed. No payment was released.",
  DEADLINE_PASSED:
    "The task deadline ({deadline}) has passed. No payment is released and the locked funds will return to you.",
} as const;

export type BlockCode = keyof typeof BLOCK_TEMPLATES;
export const BLOCK_CODES = Object.keys(BLOCK_TEMPLATES) as BlockCode[];

type Placeholders<S extends string> = S extends `${string}{${infer P}}${infer R}`
  ? P | Placeholders<R>
  : never;
export type BlockParams<C extends BlockCode> = [Placeholders<(typeof BLOCK_TEMPLATES)[C]>] extends [
  never,
]
  ? Record<string, never> | undefined
  : Record<Placeholders<(typeof BLOCK_TEMPLATES)[C]>, string | number | bigint>;

export function isBlockCode(x: unknown): x is BlockCode {
  return typeof x === "string" && Object.hasOwn(BLOCK_TEMPLATES, x);
}

/** Throws if a placeholder has no param (never render a half-filled message). */
export function renderBlockMessage<C extends BlockCode>(
  code: C,
  ...[params]: [BlockParams<C>] | []
): string {
  const p = (params ?? {}) as Record<string, string | number | bigint>;
  return BLOCK_TEMPLATES[code].replace(/\{([a-z_]+)\}/g, (_m, k: string) => {
    const v = p[k];
    if (v === undefined) throw new Error(`Missing param "${k}" for ${code}`);
    return String(v);
  });
}
