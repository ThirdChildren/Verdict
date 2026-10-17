import type { ReactNode } from "react";

/** In-place notice: a soft card with an ink accent on the left and a bold first line. Replaces toasts and tinted alerts. */
export function Note(props: {
  title?: string;
  role?: "alert" | "status";
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div
      role={props.role ?? "status"}
      className={`animate-soft-in grid gap-1 rounded-xl border border-rule-soft border-l-4 border-l-ink bg-surface/60 px-4 py-3 ${props.className ?? ""}`}
    >
      {props.title && <p className="text-xl font-semibold">{props.title}</p>}
      {props.children}
    </div>
  );
}
