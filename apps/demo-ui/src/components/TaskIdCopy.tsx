import { useState } from "react";

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
  const [failed, setFailed] = useState(false);
  const copy = async () => {
    if (await copyText(taskId)) {
      setFailed(false);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } else {
      setFailed(true);
    }
  };
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <span className="text-sm text-subtle uppercase">Task id</span>
      <code className="font-mono text-base break-all select-all">{taskId}</code>
      <button
        type="button"
        onClick={copy}
        aria-label="Copy task id"
        className="cursor-pointer text-sm font-semibold uppercase underline decoration-rule underline-offset-4 outline-none hover:decoration-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
      >
        <span aria-live="polite">{copied ? "Copied" : "Copy"}</span>
      </button>
      {failed && (
        <span role="alert" className="text-sm font-semibold">
          Copy is not available here. Select the task id and copy it by hand.
        </span>
      )}
    </div>
  );
}
