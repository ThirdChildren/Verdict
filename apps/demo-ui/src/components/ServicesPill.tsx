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
  const glyph = bad ? "▲" : up === SERVICES.length ? "■" : "□";
  const note = bad
    ? `${down.map((s) => LABEL[s]).join(", ")} down`
    : waiting.length > 0
      ? `${waiting.map((s) => LABEL[s]).join(", ")} connecting`
      : null;
  return (
    <div className="flex shrink-0 items-center gap-3 text-sm">
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={`Services ${up} of ${SERVICES.length} connected`}
              className={`cursor-pointer whitespace-nowrap uppercase outline-none focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-ring ${bad ? "font-semibold" : ""}`}
            >
              <span aria-hidden>{glyph} </span>
              <span>
                Services {up}/{SERVICES.length}
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
      {bad && <WordButton onClick={props.onReconnect}>Reconnect</WordButton>}
    </div>
  );
}
