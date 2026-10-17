import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

/** Middle-truncated form of a long id: first 8 and last 6 characters. */
export function middle(value: string, head = 8, tail = 6): string {
  return value.length <= head + tail + 1 ? value : `${value.slice(0, head)}…${value.slice(-tail)}`;
}

/** The one place hashes, ids and signatures are shown: mono, middle-truncated, full value in the title, copy button. */
export function Hash(props: { value: string; label?: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(props.value);
      setCopied(true);
      toast.success(`${props.label ?? "Value"} copied`);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Copy is not available in this browser.");
    }
  };
  const Icon = copied ? Check : Copy;
  return (
    <span className={cn("inline-flex items-center gap-1", props.className)}>
      <code className="font-mono text-sm" title={props.value}>
        {middle(props.value)}
      </code>
      <button
        type="button"
        onClick={copy}
        aria-label={`Copy ${props.label ?? "value"}`}
        title="Copy"
        className="inline-flex size-7 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
      >
        <Icon aria-hidden className="size-4" />
      </button>
    </span>
  );
}
