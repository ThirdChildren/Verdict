import { toast } from "sonner";

/** Red toast for a blocked request. Colour is backed by the word BLOCKED and the shield icon in the text. */
export function blockToast(): void {
  toast.warning("Blocked by your mandate", {
    description: "Nothing was signed. No funds moved. Select the Blocked row for details.",
    duration: 8000,
    classNames: {
      toast:
        "!border !border-danger-border !bg-danger-soft !text-danger-soft-foreground !shadow-none ![font-family:inherit]",
      description: "!text-danger-soft-foreground",
    },
  });
}

/** The toast only helps when the Blocked row is not already on screen. */
export const shouldToastBlock = (selected: string | null, blockSeq: number): boolean =>
  selected !== `block:${blockSeq}`;

/** A reconnect may replay old history: only blocks from the last two minutes (or any in mock mode) raise a toast. */
export function isFreshBlock(at: string, now: number, mock: boolean): boolean {
  return mock || now - Date.parse(at) < 120_000;
}
