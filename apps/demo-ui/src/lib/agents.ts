import { type SpendIntent, spendIntentSchema } from "@verdict/protocol";
import { z } from "zod";

/** What the engine reports for a blocked attempt: any subset of the spend intent. Never throws. */
const partialIntent = z
  .object({
    amount: z.string().optional(),
    counterparty: z.string().optional(),
    category: z.string().optional(),
    deadline: z.string().optional(),
    rationale: z.string().optional(),
    task_spec: z.string().optional(),
  })
  .passthrough();
export type IntentFacts = z.infer<typeof partialIntent>;

export function intentFacts(intent: unknown): IntentFacts {
  const r = partialIntent.safeParse(intent);
  return r.success ? r.data : {};
}

/** Accepted intent from the evidence route (needs engine field `intent`); null when absent or malformed. */
export function acceptedIntent(intent: unknown): SpendIntent | null {
  const r = spendIntentSchema.safeParse(intent);
  return r.success ? r.data : null;
}

export const SELF_CHECK_WORD: Record<string, string> = {
  PASS: "PASS",
  FAIL: "FAIL",
  WITHHOLD: "not checked",
  "not run": "not checked",
};

export const baseName = (path: string): string => path.split("/").pop() || path;
export const byteLength = (s: string): number => new TextEncoder().encode(s).length;
export const lineCount = (s: string): number => (s === "" ? 0 : s.split("\n").length);

/** The worker's switches at task start, in words. */
export function togglesWord(t: { sabotaged: boolean; disappears: boolean } | undefined): string {
  if (!t) return "not reported";
  const on = [t.sabotaged ? "sabotage on" : "", t.disappears ? "worker disappears on" : ""].filter(
    Boolean,
  );
  return on.length ? on.join(" · ") : "normal (no demo switch on)";
}

/** Saves text as a file through a Blob URL. Delivery files are text and are never executed or rendered. */
export function downloadText(path: string, content: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: "text/plain;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = baseName(path);
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
