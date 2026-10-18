import type { RootCapability } from "@verdict/protocol";
import {
  Bot,
  Ellipsis,
  Keyboard,
  Moon,
  PanelRight,
  Plus,
  Presentation,
  ShieldCheck,
  Sun,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { IconButton } from "@/components/ui/icon-button";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { AppState } from "../store.js";
import { BudgetMeter } from "./BudgetMeter.js";
import { MandatePill } from "./MandatePill.js";
import { PrincipalChip } from "./PrincipalChip.js";
import { ServicesPill } from "./ServicesPill.js";
import { useTheme } from "./ThemeProvider.js";

/**
 * One header line, three groups: identity and money on the left (brand, budget, mandate), connections in the middle
 * (principal, services), and four icon controls on the right. Presenter size and the shortcut list live in the "More" menu.
 */
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
  /** The selected mandate when it is not the live root. */
  shown?: { ceiling: string; frozenAt?: string };
}) {
  const { theme, toggle } = useTheme();
  const dark = theme === "dark";
  return (
    <TooltipProvider>
      <header className="sticky top-0 z-30 flex flex-nowrap items-center gap-x-3 border-b border-rule-soft bg-paper/80 px-4 py-2.5 shadow-soft backdrop-blur-md min-[1440px]:gap-x-4 min-[1440px]:px-6">
        <div className="flex shrink-0 items-center gap-2.5">
          <span
            aria-hidden
            className="grid size-9 place-items-center  bg-bitcoin text-ink shadow-soft"
          >
            <ShieldCheck className="size-5" strokeWidth={2} />
          </span>
          <h1 className="text-xl font-semibold tracking-tight">Verdict</h1>
          <span className="hidden border border-rule-soft bg-card px-2.5 py-0.5 font-mono text-xs whitespace-nowrap text-subtle min-[1440px]:inline [.presenter_&]:hidden">
            regtest · tUSD
          </span>
        </div>
        <BudgetMeter
          state={props.state}
          {...(props.shown ? { ceiling: props.shown.ceiling } : {})}
          {...(props.shown?.frozenAt ? { frozenAt: props.shown.frozenAt } : {})}
        />
        <div className="flex shrink-0 items-center gap-1.5">
          <MandatePill
            root={props.root}
            onClick={props.onMandate}
            selected={
              props.state.selectedMandate
                ? props.state.mandates.get(props.state.selectedMandate)
                : undefined
            }
          />
          {props.root && (
            <IconButton
              icon={Plus}
              label="New mandate"
              hint="replaces the current one"
              onClick={props.onNewMandate}
            />
          )}
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <PrincipalChip />
          <ServicesPill state={props.state} onReconnect={props.onReconnect} />
        </div>
        <nav
          aria-label="View"
          className="flex shrink-0 items-center gap-0.5 border-l border-rule-soft pl-2"
        >
          <IconButton
            icon={Bot}
            label="Agents: what each agent did"
            hint="a"
            onClick={props.onAgents}
          />
          <IconButton
            icon={PanelRight}
            label="Technical details"
            hint="i"
            aria-pressed={props.inspectorOpen}
            onClick={props.onToggleInspector}
          />
          <IconButton
            icon={dark ? Sun : Moon}
            label={dark ? "Switch to light theme" : "Switch to dark theme"}
            hint="t"
            aria-pressed={dark}
            onClick={toggle}
          />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label="More"
                className="inline-flex size-9 shrink-0 items-center justify-center  outline-none transition hover:bg-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring data-[state=open]:bg-surface"
              >
                <Ellipsis aria-hidden className="size-[1.15rem]" strokeWidth={1.75} />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem onSelect={props.onTogglePresenter}>
                <Presentation aria-hidden />
                {props.presenter ? "Normal text size" : "Presenter size"}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={props.onHelp}>
                <Keyboard aria-hidden />
                Keyboard shortcuts
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </nav>
      </header>
    </TooltipProvider>
  );
}
