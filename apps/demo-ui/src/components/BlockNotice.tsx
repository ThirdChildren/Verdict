import { WordButton } from "@/components/ui/word-button";
import { Note } from "./Note.js";

export const BLOCK_NOTICE_TITLE = "Blocked by your mandate";
export const BLOCK_NOTICE_BODY =
  "Nothing was signed. No funds moved. Select the Blocked row for details.";

/** In-place notice (no toast) shown when a request is refused and its Blocked row is not on screen. */
export function BlockNotice(props: { onDismiss: () => void }) {
  return (
    <Note title={BLOCK_NOTICE_TITLE} role="status">
      <p>{BLOCK_NOTICE_BODY}</p>
      <WordButton onClick={props.onDismiss} className="justify-self-start">
        Dismiss
      </WordButton>
    </Note>
  );
}
