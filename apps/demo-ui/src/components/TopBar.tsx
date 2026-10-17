import type { RootCapability } from "@verdict/protocol";
import { WordButton } from "@/components/ui/word-button";
import type { AppState } from "../store.js";
import { BudgetMeter } from "./BudgetMeter.js";
import { MandatePill } from "./MandatePill.js";
import { ServicesPill } from "./ServicesPill.js";
import { useTheme } from "./ThemeProvider.js";

/** One header line: product, network, budget ledger, mandate, services, and four word controls. */
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
    <header className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b-2 border-ink bg-paper px-6 py-3 [.presenter_&]:gap-x-4">
      <div className="flex shrink-0 items-baseline gap-3">
        <h1 className="text-xl font-semibold tracking-tight">Verdict</h1>
        <span className="font-mono text-sm whitespace-nowrap text-subtle">regtest · tUSD</span>
      </div>
      <BudgetMeter state={props.state} />
      <MandatePill root={props.root} onClick={props.onMandate} />
      <ServicesPill state={props.state} onReconnect={props.onReconnect} />
      <nav aria-label="View" className="flex shrink-0 items-center gap-3">
        <WordButton
          onClick={props.onTogglePresenter}
          aria-pressed={props.presenter}
          aria-label="Presenter size"
          title="Larger text for a projector (p)"
        >
          Presenter
        </WordButton>
        <WordButton
          onClick={props.onHelp}
          aria-label="Keyboard shortcuts"
          title="Keyboard shortcuts (?)"
        >
          Help
        </WordButton>
        <WordButton
          onClick={toggle}
          aria-pressed={dark}
          aria-label={dark ? "Switch to light theme" : "Switch to dark theme"}
          title="Switch light / dark theme (t)"
        >
          Theme
        </WordButton>
        <WordButton
          onClick={props.onToggleInspector}
          aria-pressed={props.inspectorOpen}
          aria-label="Technical details"
          title="Technical details (i)"
        >
          Details
        </WordButton>
      </nav>
    </header>
  );
}
