import { Activity, TriangleAlert } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { WordButton } from "@/components/ui/word-button";
import type { AppState, ConnStatus, Service } from "../store.js";

const LABEL: Record<Service, string> = { engine: "Engine", worker: "Worker", verifier: "Verifier" };
const WORD: Record<ConnStatus, string> = {
  connecting: "connecting",
  connected: "connected",
  disconnected: "down",
  mock: "mock data",
};
const SERVICES = Object.keys(LABEL) as Service[];
const isUp = (c: ConnStatus) => c === "connected" || c === "mock";

/** Services as one line of words: "Services 3/3", bold and named when one is down, with a Reconnect word. */
export function ServicesPill(props: { state: AppState; onReconnect: () => void }) {
  const conns = props.state.connections;
  const up = SERVICES.filter((s) => isUp(conns[s])).length;
  const down = SERVICES.filter((s) => conns[s] === "disconnected");
  const waiting = SERVICES.filter((s) => conns[s] === "connecting");
  const bad = down.length > 0;
  const note = bad
    ? `${down.map((s) => LABEL[s]).join(", ")} down`
    : waiting.length > 0
      ? `${waiting.map((s) => LABEL[s]).join(", ")} connecting`
      : null;
  const Icon = bad ? TriangleAlert : Activity;
  return (
    <div className="flex shrink-0 items-center gap-2 text-sm">
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={`Services ${up} of ${SERVICES.length} connected`}
              className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 whitespace-nowrap shadow-soft outline-none transition hover:bg-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ${bad ? "border-bad/50 font-semibold text-bad" : "border-rule-soft bg-card"}`}
            >
              <Icon
                aria-hidden
                className={`size-4 ${bad ? "" : up === SERVICES.length ? "text-ok" : "text-warn"}`}
              />
              <span>
                <span className="hidden min-[1440px]:inline">Services </span>
                {up}/{SERVICES.length}
              </span>
              {note && <span className="font-semibold"> · {note}</span>}
            </button>
          </TooltipTrigger>
          <TooltipContent>
            <ul className="grid gap-1">
              {SERVICES.map((s) => (
                <li key={s}>
                  {LABEL[s]}: {WORD[conns[s]]}
                </li>
              ))}
            </ul>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
      {bad && (
        <WordButton onClick={props.onReconnect} className="normal-case">
          Reconnect
        </WordButton>
      )}
    </div>
  );
}
