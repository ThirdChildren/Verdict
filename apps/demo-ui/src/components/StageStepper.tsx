import type { StepState, StepView } from "../lib/view.js";
import { Mark, type MarkKind } from "./Mark.js";
import { timeOf } from "./PaymentTimeline.js";

interface Look {
  word: string;
  mark: MarkKind;
  muted: boolean;
}
const LOOK: Record<StepState, Look> = {
  done: { word: "Done", mark: "done", muted: false },
  active: { word: "Now", mark: "now", muted: false },
  failed: { word: "Needs attention", mark: "fail", muted: false },
  skipped: { word: "Skipped", mark: "skip", muted: true },
  pending: { word: "Waiting", mark: "wait", muted: true },
};

/** A failed last step is not always an error: a refund is "Returned", an expiry is "Expired". */
function failedLook(label: string): Look {
  if (label === "Refunded") return { word: "Returned", mark: "refund", muted: false };
  if (label === "Expired") return { word: "Expired", mark: "expired", muted: true };
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
    <ol aria-label="Progress" className="grid gap-1.5 font-mono text-sm">
      {props.steps.map((s, i) => {
        const look =
          s.state === "failed"
            ? s.word === STOPPED_WORD
              ? { word: STOPPED_WORD, mark: "attention" as const, muted: false }
              : failedLook(s.label)
            : LOOK[s.state];
        const word = s.word ?? look.word;
        const current = s.state === "active" || s.state === "failed";
        return (
          <li key={s.id}>
            <button
              type="button"
              onClick={() => props.onShow(i)}
              aria-current={current ? "step" : undefined}
              aria-pressed={props.shown === i}
              className={`grid h-11 w-full grid-cols-[1.25rem_2.5ch_12ch_minmax(0,1fr)_auto] items-center gap-x-3  border px-3 text-left shadow-soft outline-none transition duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ${current ? "border-signal/60 bg-card ring-2 ring-signal/15" : "border-rule-soft"} ${props.shown === i ? "bg-surface" : current ? "" : "bg-card/60 hover:bg-card hover:shadow-lift"} ${look.muted ? "text-subtle" : "text-ink"}`}
            >
              <Mark kind={look.mark} className="size-5" />
              <span>{String(i + 1).padStart(2, "0")}</span>
              <span className="truncate font-semibold uppercase">{s.label}</span>
              <span className="truncate">
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
