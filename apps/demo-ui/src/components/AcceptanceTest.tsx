import { useId } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { type Draft, FEASIBLE_LINE, hiddenLine, rulesOf } from "../lib/authoring.js";

const AREA =
  "min-h-11 w-full border border-input bg-card px-2 py-1 font-mono text-sm text-ink outline-none focus-visible:border-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

/** The draft the principal can edit: title, description and the visible cases. Hidden cases never appear here. */
export type Edits = Pick<Draft, "title" | "description" | "visible">;

/** Ruled "Acceptance test" panel: what the verifier will check, in words and in cases. */
export function AcceptanceTest(props: {
  draft: Draft;
  edits: Edits;
  onEdit: (e: Edits) => void;
  onInstall: () => void;
  installing: boolean;
  error: string | null;
}) {
  const id = useId();
  const { draft, edits } = props;
  const rules = rulesOf(draft.assertions);
  const setCase = (i: number, key: "input" | "expected", v: string) =>
    props.onEdit({
      ...edits,
      visible: edits.visible.map((c, j) => (j === i ? { ...c, [key]: v } : c)),
    });
  return (
    <section aria-label="Acceptance test" className="grid gap-3 border-y border-rule-soft py-3">
      <h3 className="text-lg font-semibold">Acceptance test</h3>
      <p className="text-base font-semibold" aria-live="polite">
        {draft.feasibility === "cli"
          ? FEASIBLE_LINE
          : (draft.reframe ?? draft.reason) ||
            "This request was reframed so a program can check it."}
      </p>
      {draft.feasibility === "reframe" && draft.reason && draft.reframe && (
        <p className="text-base text-subtle">{draft.reason}</p>
      )}
      <div className="grid gap-1">
        <Label htmlFor={`${id}-t`} className="font-semibold">
          Title
        </Label>
        <Input
          id={`${id}-t`}
          value={edits.title}
          onChange={(e) => props.onEdit({ ...edits, title: e.target.value })}
        />
      </div>
      <div className="grid gap-1">
        <Label htmlFor={`${id}-d`} className="font-semibold">
          What the program must do
        </Label>
        <Input
          id={`${id}-d`}
          value={edits.description}
          onChange={(e) => props.onEdit({ ...edits, description: e.target.value })}
        />
      </div>
      <table className="w-full border-collapse text-left">
        <caption className="pb-1 text-left font-semibold">
          Cases the worker can see: input, then the exact expected output
        </caption>
        <thead>
          <tr className="border-b border-rule-soft text-sm uppercase text-subtle">
            <th scope="col" className="w-8 py-1 font-mono">
              #
            </th>
            <th scope="col" className="py-1">
              Input
            </th>
            <th scope="col" className="py-1">
              Expected output
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-rule-soft">
          {edits.visible.map((c, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: cases are edited in place and never reordered
            <tr key={i} className="align-top">
              <td className="py-2 font-mono text-sm text-subtle">
                {String(i + 1).padStart(2, "0")}
              </td>
              <td className="py-2 pr-2">
                <textarea
                  rows={2}
                  aria-label={`Case ${i + 1} input`}
                  className={AREA}
                  value={c.input}
                  onChange={(e) => setCase(i, "input", e.target.value)}
                />
              </td>
              <td className="py-2">
                <textarea
                  rows={2}
                  aria-label={`Case ${i + 1} expected output`}
                  className={AREA}
                  value={c.expected}
                  onChange={(e) => setCase(i, "expected", e.target.value)}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-base">{hiddenLine(draft.hidden.length)}</p>
      {rules.length > 0 && (
        <div>
          <p className="font-semibold">The rules, in words</p>
          <ul className="list-inside list-disc text-base">
            {rules.map((r, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: rules are a fixed list
              <li key={i}>{r}</li>
            ))}
          </ul>
        </div>
      )}
      <p className="text-base text-subtle">
        A model wrote these expected outputs. Check each one: if one is wrong, an honest worker
        fails and the money is refunded.
      </p>
      {props.error && (
        <p role="alert" className="font-semibold">
          {props.error}
        </p>
      )}
      <div>
        <Button type="button" onClick={props.onInstall} disabled={props.installing}>
          {props.installing ? "Installing..." : "Install test and use it"}
        </Button>
      </div>
    </section>
  );
}
