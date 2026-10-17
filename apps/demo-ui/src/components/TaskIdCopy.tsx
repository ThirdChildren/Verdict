import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

/** Copies text; falls back to a hidden textarea when the async clipboard API is missing or refuses. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }
}

/** The full task id in mono with a copy button; the id is what the "re-run it yourself" commands need. */
export function TaskIdCopy({ taskId }: { taskId: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (await copyText(taskId)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } else {
      toast.error("Copy is not available here. Select the task id and copy it by hand.");
    }
  };
  const Icon = copied ? Check : Copy;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-base">Task id</span>
      <code className="font-mono text-base break-all select-all">{taskId}</code>
      <button
        type="button"
        onClick={copy}
        aria-label="Copy task id"
        className="inline-flex min-h-9 items-center gap-1 rounded border px-2 text-base hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
      >
        <Icon aria-hidden className="size-4" />
        <span aria-live="polite">{copied ? "Copied" : "Copy"}</span>
      </button>
    </div>
  );
}
