import {
  Ban,
  Check,
  Circle,
  Hourglass,
  Loader2,
  RotateCcw,
  TriangleAlert,
  XCircle,
} from "lucide-react";
import type { StepState, StepView } from "../lib/view.js";
import { timeOf } from "./PaymentTimeline.js";

const LOOK: Record<StepState, { word: string; text: string; bar: string; Icon: typeof Check }> = {
  done: { word: "Done", text: "text-foreground", bar: "bg-foreground", Icon: Check },
  active: { word: "Now", text: "text-primary", bar: "bg-primary", Icon: Loader2 },
  failed: { word: "Needs attention", text: "text-danger", bar: "bg-danger", Icon: XCircle },
  skipped: { word: "Skipped", text: "text-muted-foreground", bar: "bg-border", Icon: Ban },
  pending: { word: "Waiting", text: "text-muted-foreground", bar: "bg-border", Icon: Circle },
};

/** A failed step is red only when something broke; a refund is blue (money returned), an expiry is neutral. */
function failedLook(label: string): (typeof LOOK)[StepState] {
  if (label === "Refunded")
    return { word: "Returned", text: "text-info", bar: "bg-info", Icon: RotateCcw };
  if (label === "Expired")
    return {
      word: "Expired",
      text: "text-muted-foreground",
      bar: "bg-muted-foreground",
      Icon: Hourglass,
    };
  return LOOK.failed;
}

const STOPPED_LOOK = {
  word: "Worker stopped responding",
  text: "text-warn",
  bar: "bg-warn",
  Icon: TriangleAlert,
};

/** Five steps in one row: icon, label, machine, state word and time. Steps are buttons: click to look at one. */
export function StageStepper(props: {
  steps: StepView[];
  shown: number;
  onShow: (i: number) => void;
}) {
  return (
    <ol aria-label="Progress" className="grid grid-cols-5 gap-4">
      {props.steps.map((s, i) => {
        const look =
          s.state === "failed"
            ? s.word === STOPPED_LOOK.word
              ? STOPPED_LOOK
              : failedLook(s.label)
            : LOOK[s.state];
        const { text, bar, Icon } = look;
        const word = s.word ?? look.word;
        return (
          <li key={s.id}>
            <button
              type="button"
              onClick={() => props.onShow(i)}
              aria-current={s.state === "active" || s.state === "failed" ? "step" : undefined}
              aria-pressed={props.shown === i}
              className={`grid w-full gap-1 rounded-md pb-2 text-left ${text} ${props.shown === i ? "bg-muted" : ""}`}
            >
              <span className={`h-1 w-full rounded-full ${bar}`} />
              <span className="flex items-center gap-2 pt-2 text-base font-semibold">
                <Icon
                  aria-hidden
                  className={`size-4 shrink-0 ${s.state === "active" ? "motion-safe:animate-spin" : ""}`}
                />
                <span className="truncate">{s.label}</span>
              </span>
              <span className="flex gap-1 text-base">
                <span>{word}</span>
                {s.at && <span className="tabular-nums">· {timeOf(s.at)}</span>}
              </span>
              <span className="text-base text-muted-foreground">{s.machine}</span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}
