import type { RootCapability } from "@verdict/protocol";
import { Archive, ScrollText, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { clockHm, type MandateRow, rowStatus } from "../lib/mandates.js";

export type MandateStatus = "none" | "active" | "expired" | "retired";

export function mandateStatus(root: RootCapability | null, now: number): MandateStatus {
  if (!root) return "none";
  return Date.parse(root.expires_at) > now ? "active" : "expired";
}

export function timeLeft(expiresAt: string, now: number): string {
  const mins = Math.max(0, Math.floor((Date.parse(expiresAt) - now) / 60000));
  const h = Math.floor(mins / 60);
  return h > 0 ? `${h}h ${mins % 60}m left` : `${mins}m left`;
}

/** The word for the selected mandate when it is a retired or expired one; null for the live one. */
export function selectedWord(row: MandateRow | undefined, now: number): string | null {
  if (!row) return null;
  const st = rowStatus(row, now);
  if (st === "retired") return `Mandate · retired ${clockHm(row.retired_at)}`;
  if (st === "expired") return "Mandate · expired";
  return null;
}

export function MandatePill(props: {
  root: RootCapability | null;
  onClick: () => void;
  /** The mandate selected in the list; the pill describes it. */
  selected?: MandateRow | undefined;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  const sel = selectedWord(props.selected, now);
  const st: MandateStatus = sel
    ? props.selected && rowStatus(props.selected, now) === "retired"
      ? "retired"
      : "expired"
    : mandateStatus(props.root, now);
  const text =
    sel ??
    (st === "active" && props.root
      ? `Mandate · ${timeLeft(props.root.expires_at, now)}`
      : st === "expired"
        ? "Mandate expired"
        : "No mandate");
  const Icon = st === "active" ? ScrollText : st === "retired" ? Archive : TriangleAlert;
  return (
    <button
      type="button"
      onClick={props.onClick}
      title="Show the rules of this mandate (m)"
      className={`inline-flex shrink-0 items-center gap-2  border bg-card px-3 py-1.5 text-sm whitespace-nowrap shadow-soft outline-none transition hover:bg-surface hover:shadow-lift focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ${st === "active" ? "border-rule-soft" : "border-warn/50 font-semibold"}`}
    >
      <Icon aria-hidden className={`size-4 ${st === "active" ? "text-ok" : "text-warn"}`} />
      <span className="hidden min-[1440px]:inline">{text}</span>
      <span className="min-[1440px]:hidden">{text.replace(/(\d+h) (\d+m)/, "$1$2")}</span>
    </button>
  );
}
