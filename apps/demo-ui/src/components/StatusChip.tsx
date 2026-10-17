import type { Chip } from "../lib/view.js";

/** Glyph in ink: ▲ in progress, ■ settled or refused, □ lapsed. Never a coloured fill. */
const GLYPH: Record<Chip, string> = {
  Working: "▲",
  Locked: "▲",
  Verifying: "▲",
  "Refund pending": "▲",
  Paid: "■",
  Refunded: "■",
  Expired: "□",
  Blocked: "■",
};

/** Status of a task as an uppercase word with weight and a glyph; the text stays the original string. */
export function StatusChip({ chip }: { chip: Chip }) {
  return (
    <span className="text-sm font-semibold whitespace-nowrap uppercase">
      <span aria-hidden>{GLYPH[chip]} </span>
      {chip}
    </span>
  );
}
