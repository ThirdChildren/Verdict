import {
  AlertTriangle,
  CheckCircle2,
  Circle,
  Clock,
  Loader2,
  MinusCircle,
  RotateCcw,
  ShieldAlert,
  Undo2,
  XCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";

/** The one place status marks are drawn: an icon (never the only carrier of meaning; a word always sits next to it). */
export const MARKS = {
  done: { icon: CheckCircle2, tone: "text-ok" },
  now: { icon: Loader2, tone: "text-signal", spin: true },
  wait: { icon: Circle, tone: "text-subtle" },
  skip: { icon: MinusCircle, tone: "text-subtle" },
  attention: { icon: AlertTriangle, tone: "text-warn" },
  fail: { icon: XCircle, tone: "text-bad" },
  blocked: { icon: ShieldAlert, tone: "text-bad" },
  refund: { icon: Undo2, tone: "text-ok" },
  pending: { icon: RotateCcw, tone: "text-warn" },
  expired: { icon: Clock, tone: "text-subtle" },
} as const;
export type MarkKind = keyof typeof MARKS;

export function Mark({ kind, className }: { kind: MarkKind; className?: string }) {
  const m = MARKS[kind];
  const Icon = m.icon;
  return (
    <Icon
      aria-hidden
      className={cn(
        "inline size-[1.05em] shrink-0 align-[-0.15em]",
        m.tone,
        "spin" in m && "animate-spin",
        className,
      )}
      strokeWidth={2}
    />
  );
}
