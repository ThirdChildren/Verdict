import type { Chip } from "../lib/view.js";
import { Mark, type MarkKind } from "./Mark.js";

const LOOK: Record<Chip, { mark: MarkKind; pill: string }> = {
  Working: { mark: "now", pill: "bg-signal/10 text-signal" },
  Locked: { mark: "now", pill: "bg-signal/10 text-signal" },
  Verifying: { mark: "now", pill: "bg-signal/10 text-signal" },
  "Refund pending": { mark: "pending", pill: "bg-warn/12 text-warn" },
  Paid: { mark: "done", pill: "bg-ok/12 text-ok" },
  Refunded: { mark: "refund", pill: "bg-ok/12 text-ok" },
  Expired: { mark: "expired", pill: "border border-rule-soft bg-card text-subtle" },
  Blocked: { mark: "blocked", pill: "bg-bad/12 text-bad" },
};

/** Status of a task as a soft pill: an icon, then the word. The text stays the original string. */
export function StatusChip({ chip }: { chip: Chip }) {
  const l = LOOK[chip];
  return (
    <span
      className={`inline-flex items-center gap-1.5  px-2.5 py-0.5 text-xs font-semibold whitespace-nowrap uppercase ${l.pill}`}
    >
      <Mark kind={l.mark} className="text-current" />
      {chip}
    </span>
  );
}
