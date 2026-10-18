import type { BlockCode } from "@verdict/protocol";
import { BLOCK_TITLES, blockReassurance } from "../lib/blocks.js";

/** Catalogue messages already end with the reassurance sentence; it is shown once, below. */
const REASSURANCE_DUP = /\s*Nothing was signed( and no funds moved|\.\s*No funds moved)\.?$/;

/** BLOCK card: plain text with a 2px ink rule. The catalogue message verbatim plus what did not happen. */
export function BlockCard(props: {
  code: BlockCode;
  message: string;
  remaining?: string | null | undefined;
}) {
  return (
    <div
      role="alert"
      aria-label={`Blocked: ${BLOCK_TITLES[props.code]}`}
      className="grid gap-2  border border-bad/40 border-l-4 border-l-bad bg-card px-5 py-4 shadow-soft"
    >
      <p className="text-xl font-semibold">BLOCKED: {BLOCK_TITLES[props.code]}</p>
      <p className="text-base">{props.message.replace(REASSURANCE_DUP, "")}</p>
      <p className="text-base font-semibold">{blockReassurance(props.code)}</p>
      {props.remaining && (
        <p className="text-base">Your budget is unchanged: {props.remaining} tUSD left.</p>
      )}
      <p className="font-mono text-base">Reason code: {props.code}</p>
    </div>
  );
}
