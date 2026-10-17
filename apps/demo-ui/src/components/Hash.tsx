import { useState } from "react";
import { cn } from "@/lib/utils";

/** Middle-truncated form of a long id: first 8 and last 6 characters. */
export function middle(value: string, head = 8, tail = 6): string {
  return value.length <= head + tail + 1 ? value : `${value.slice(0, head)}…${value.slice(-tail)}`;
}

/** The one place hashes, ids and signatures are shown: mono, middle-truncated, full value in the title, copy button. */
export function Hash(props: { value: string; label?: string; className?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(props.value);
      setState("copied");
      setTimeout(() => setState("idle"), 1500);
    } catch {
      setState("failed");
    }
  };
  return (
    <span className={cn("inline-flex items-baseline gap-2", props.className)}>
      <code className="font-mono text-sm" title={props.value}>
        {middle(props.value)}
      </code>
      <button
        type="button"
        onClick={copy}
        aria-label={`Copy ${props.label ?? "value"}`}
        title="Copy"
        className="cursor-pointer text-xs font-semibold uppercase underline decoration-rule underline-offset-4 outline-none hover:decoration-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
      >
        <span aria-live="polite">
          {state === "copied" ? "Copied" : state === "failed" ? "Copy unavailable" : "Copy"}
        </span>
      </button>
    </span>
  );
}
