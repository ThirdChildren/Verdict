import type { StepState, StepView } from "../lib/view.js";
import { timeOf } from "./PaymentTimeline.js";

interface Look {
  word: string;
  glyph: string;
  muted: boolean;
}
const LOOK: Record<StepState, Look> = {
  done: { word: "Done", glyph: "■", muted: false },
  active: { word: "Now", glyph: "▲", muted: false },
  failed: { word: "Needs attention", glyph: "■", muted: false },
  skipped: { word: "Skipped", glyph: "–", muted: true },
  pending: { word: "Waiting", glyph: "□", muted: true },
};

/** A failed last step is not always an error: a refund is "Returned", an expiry is "Expired". */
function failedLook(label: string): Look {
  if (label === "Refunded") return { word: "Returned", glyph: "■", muted: false };
  if (label === "Expired") return { word: "Expired", glyph: "□", muted: true };
  return LOOK.failed;
}

const STOPPED_WORD = "Worker stopped responding";

/** Five steps as ledger rows: number, step, state and time, machine. Rows are buttons: click to look at one. */
export function StageStepper(props: {
  steps: StepView[];
  shown: number;
  onShow: (i: number) => void;
}) {
  return (
    <ol aria-label="Progress" className="border-y border-rule font-mono text-sm">
      {props.steps.map((s, i) => {
        const look =
          s.state === "failed"
            ? s.word === STOPPED_WORD
              ? { word: STOPPED_WORD, glyph: "▲", muted: false }
              : failedLook(s.label)
            : LOOK[s.state];
        const word = s.word ?? look.word;
        const current = s.state === "active" || s.state === "failed";
        return (
          <li key={s.id} className="border-b border-rule-soft last:border-b-0">
            <button
              type="button"
              onClick={() => props.onShow(i)}
              aria-current={current ? "step" : undefined}
              aria-pressed={props.shown === i}
              className={`grid h-8 w-full grid-cols-[2.5ch_12ch_minmax(0,1fr)_auto] items-center gap-x-4 border-l-2 px-2 text-left ${current ? "border-ink" : "border-transparent"} ${props.shown === i ? "bg-surface" : "hover:bg-surface"} ${look.muted ? "text-subtle" : "text-ink"}`}
            >
              <span>{String(i + 1).padStart(2, "0")}</span>
              <span className="truncate font-semibold uppercase">{s.label}</span>
              <span className="truncate">
                <span aria-hidden>{look.glyph} </span>
                <span className={current ? "font-semibold" : ""}>{word}</span>
                {s.at && <span> · {timeOf(s.at)}</span>}
              </span>
              <span className="truncate text-right">{s.machine}</span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}
