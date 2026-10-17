import type { BlockCode } from "@verdict/protocol";
import { ShieldAlert } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { BLOCK_TITLES, blockReassurance } from "../lib/blocks.js";

/** Catalogue messages already end with the reassurance sentence; it is shown once, below. */
const REASSURANCE_DUP = /\s*Nothing was signed( and no funds moved|\.\s*No funds moved)\.?$/;

/** Amber BLOCK card: the catalogue message verbatim plus what did not happen. */
export function BlockCard(props: {
  code: BlockCode;
  message: string;
  remaining?: string | null | undefined;
}) {
  return (
    <Alert
      variant="danger"
      aria-label={`Blocked: ${BLOCK_TITLES[props.code]}`}
      className="bg-danger-soft p-6 shadow-none has-[>svg]:grid-cols-[calc(var(--spacing)*6)_1fr]"
    >
      <ShieldAlert aria-hidden className="size-6!" />
      <AlertTitle className="line-clamp-none text-xl font-bold">
        BLOCKED: {BLOCK_TITLES[props.code]}
      </AlertTitle>
      <AlertDescription className="text-danger-soft-foreground">
        <p className="mt-2 text-base">{props.message.replace(REASSURANCE_DUP, "")}</p>
        <p className="mt-4 text-base font-semibold">{blockReassurance(props.code)}</p>
        {props.remaining && (
          <p className="mt-1 text-base">Your budget is unchanged: {props.remaining} tUSD left.</p>
        )}
        <p className="mt-4 font-mono text-base">Reason code: {props.code}</p>
      </AlertDescription>
    </Alert>
  );
}
