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
  onNewMandate: () => void;
  onToggleInspector: () => void;
  onAgents: () => void;
}) {
  const { theme, toggle } = useTheme();
  const dark = theme === "dark";
  return (
    <header className="flex flex-nowrap items-center gap-x-4 min-[1440px]:gap-x-5 border-b-2 border-ink bg-paper px-6 py-3 [.presenter_&]:gap-x-3">
      <div className="flex shrink-0 items-baseline gap-3">
        <h1 className="text-xl font-semibold tracking-tight">Verdict</h1>
        <span className="hidden font-mono text-sm whitespace-nowrap text-subtle min-[1440px]:inline [.presenter_&]:hidden">
          regtest · tUSD
        </span>
      </div>
      <BudgetMeter state={props.state} />
      <MandatePill root={props.root} onClick={props.onMandate} />
      {props.root && (
        <WordButton
          className="text-xs tracking-wide uppercase"
          onClick={props.onNewMandate}
          title="Sign a new mandate; it replaces the current one"
        >
          New mandate
        </WordButton>
      )}
      <ServicesPill state={props.state} onReconnect={props.onReconnect} />
      <nav
        aria-label="View"
        className="ml-auto flex shrink-0 items-center gap-2.5 text-xs tracking-wide min-[1440px]:gap-3"
      >
        <WordButton
          className="text-xs tracking-wide"
          onClick={props.onTogglePresenter}
          aria-pressed={props.presenter}
          aria-label="Presenter size"
          title="Larger text for a projector (p)"
        >
          Presenter
        </WordButton>
        <WordButton
          className="text-xs tracking-wide"
          onClick={props.onHelp}
          aria-label="Keyboard shortcuts"
          title="Keyboard shortcuts (?)"
        >
          Help
        </WordButton>
        <WordButton
          className="text-xs tracking-wide"
          onClick={toggle}
          aria-pressed={dark}
          aria-label={dark ? "Switch to light theme" : "Switch to dark theme"}
          title="Switch light / dark theme (t)"
        >
          Theme
        </WordButton>
        <WordButton
          className="text-xs tracking-wide"
          onClick={props.onAgents}
          aria-label="Agents: what each agent did"
          title="What each agent decided and produced (a)"
        >
          Agents
        </WordButton>
        <WordButton
          className="text-xs tracking-wide"
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
