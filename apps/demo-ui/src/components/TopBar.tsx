import type { RootCapability } from "@verdict/protocol";
import {
  CircleHelp,
  Moon,
  PanelRight,
  Plug,
  PlugZap,
  Presentation,
  RefreshCw,
  Sun,
  TriangleAlert,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { AppState, ConnStatus, Service } from "../store.js";
import { BudgetMeter } from "./BudgetMeter.js";
import { MandatePill } from "./MandatePill.js";
import { useTheme } from "./ThemeProvider.js";

const LABEL: Record<Service, string> = { engine: "Engine", worker: "Worker", verifier: "Verifier" };
const WORD: Record<ConnStatus, string> = {
  connecting: "connecting",
  connected: "connected",
  disconnected: "down",
  mock: "mock data",
};
const SERVICES = Object.keys(LABEL) as Service[];
const isUp = (c: ConnStatus) => c === "connected" || c === "mock";

/** One pill instead of three icons: "Services 3/3", red and named when one is down. Tooltip lists each service. */
function ServicesPill(props: { state: AppState; onReconnect: () => void }) {
  const conns = props.state.connections;
  const up = SERVICES.filter((s) => isUp(conns[s])).length;
  const down = SERVICES.filter((s) => conns[s] === "disconnected");
  const waiting = SERVICES.filter((s) => conns[s] === "connecting");
  const bad = down.length > 0;
  const Icon = bad ? TriangleAlert : up === SERVICES.length ? PlugZap : Plug;
  const tone = bad
    ? "border-danger-border bg-danger-soft text-danger-soft-foreground"
    : up === SERVICES.length
      ? "border-border text-muted-foreground"
      : "border-warn-border bg-warn-soft text-warn-soft-foreground";
  const note = bad
    ? `${down.map((s) => LABEL[s]).join(", ")} down`
    : waiting.length > 0
      ? `${waiting.map((s) => LABEL[s]).join(", ")} connecting`
      : null;
  return (
    <div className="flex shrink-0 items-center gap-2">
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={`Services ${up} of ${SERVICES.length} connected`}
              className={`flex items-center gap-2 rounded-full border px-3 py-1 text-sm whitespace-nowrap ${tone}`}
            >
              <Icon aria-hidden className="size-4" />
              <span>
                Services {up}/{SERVICES.length}
              </span>
              {note && <span className="font-semibold">· {note}</span>}
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
        <Button type="button" variant="outline" size="sm" onClick={props.onReconnect}>
          <RefreshCw aria-hidden /> Reconnect
        </Button>
      )}
    </div>
  );
}

export function TopBar(props: {
  state: AppState;
  root: RootCapability | null;
  inspectorOpen: boolean;
  presenter: boolean;
  onTogglePresenter: () => void;
  onHelp: () => void;
  onReconnect: () => void;
  onMandate: () => void;
  onToggleInspector: () => void;
}) {
  const { theme, toggle } = useTheme();
  const dark = theme === "dark";
  return (
    <header className="flex items-center gap-6 border-b bg-card px-6 py-4 [.presenter_&]:gap-4">
      <div className="flex shrink-0 items-baseline gap-2">
        <h1 className="font-display text-2xl font-bold tracking-tight">Verdict</h1>
        <span className="text-sm whitespace-nowrap text-muted-foreground">regtest · tUSD</span>
      </div>
      <BudgetMeter state={props.state} />
      <MandatePill root={props.root} onClick={props.onMandate} />
      <ServicesPill state={props.state} onReconnect={props.onReconnect} />
      <div className="flex shrink-0 items-center gap-1">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={props.onTogglePresenter}
          aria-pressed={props.presenter}
          aria-label="Presenter size"
          title="Larger text for a projector (p)"
        >
          <Presentation aria-hidden />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={props.onHelp}
          aria-label="Keyboard shortcuts"
          title="Keyboard shortcuts (?)"
        >
          <CircleHelp aria-hidden />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={toggle}
          aria-pressed={dark}
          aria-label={dark ? "Switch to light theme" : "Switch to dark theme"}
          title="Switch light / dark theme (t)"
        >
          {dark ? <Sun aria-hidden /> : <Moon aria-hidden />}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={props.onToggleInspector}
          aria-pressed={props.inspectorOpen}
          aria-label="Technical details"
          title="Technical details (i)"
        >
          <PanelRight aria-hidden />
        </Button>
      </div>
    </header>
  );
}
