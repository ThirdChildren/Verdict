import type { ReactNode } from "react";

/** In-place notice: plain text with a 2px ink rule and a bold first line. Replaces toasts and tinted alerts. */
export function Note(props: {
  title?: string;
  role?: "alert" | "status";
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div
      role={props.role ?? "status"}
      className={`grid gap-1 border-l-2 border-ink py-1 pl-4 ${props.className ?? ""}`}
    >
      {props.title && <p className="text-xl font-semibold">{props.title}</p>}
      {props.children}
    </div>
  );
}
