import { type BlockCode, type BlockParams, renderBlockMessage } from "@verdict/protocol";

export type Block = { readonly ok: false; readonly code: BlockCode; readonly message: string };
export type Allow = { readonly ok: true };
export type Decision = Allow | Block;

export const ALLOW: Allow = { ok: true };

export function block<C extends BlockCode>(code: C, ...params: [BlockParams<C>] | []): Block {
  return { ok: false, code, message: renderBlockMessage(code, ...params) };
}

/** Error carrying a catalogue code; thrown by the ledger, converted to a Block at the edge. */
export class BlockError extends Error {
  override readonly name = "BlockError";
  constructor(
    readonly code: BlockCode,
    readonly userMessage: string,
  ) {
    super(`${code}: ${userMessage}`);
  }
}

/** Fail closed: any exception inside a check becomes a BLOCK, never an allow. */
export function failClosed(fn: () => Decision): Decision {
  try {
    return fn();
  } catch (e) {
    if (e instanceof BlockError) return { ok: false, code: e.code, message: e.userMessage };
    const reason = e instanceof Error ? e.message : "unknown error";
    return block("MALFORMED_INTENT", { reason });
  }
}

/** Appends a human-readable detail to a block message without changing its catalogue code. */
export function withDetail(b: Block, detail: string): Block {
  return { ...b, message: `${b.message} ${detail}` };
}
