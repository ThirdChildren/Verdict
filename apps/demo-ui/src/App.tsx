import { WifiOff } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { AgentsPanel } from "./components/AgentsPanel.js";
import { BlockNotice } from "./components/BlockNotice.js";
import { DemoConsole } from "./components/DemoConsole.js";
import { EmptyState } from "./components/EmptyState.js";
import { FundsPanel } from "./components/FundsPanel.js";
import { Inspector } from "./components/Inspector.js";
import { MandateList, mandateNeighbour, sortedMandates } from "./components/MandateList.js";
import { MandateSummary } from "./components/MandateSummary.js";
import { MandateWizard } from "./components/MandateWizard.js";
import { MockBanner } from "./components/MockBanner.js";
import { NewTaskButton } from "./components/NewTaskButton.js";
import { ShortcutHelp } from "./components/ShortcutHelp.js";
import { Stage } from "./components/Stage.js";
import { neighbour, TaskRail } from "./components/TaskRail.js";
import { useTheme } from "./components/ThemeProvider.js";
import { TopBar } from "./components/TopBar.js";
import { useLiveStream } from "./components/WorkerLane.js";
import { connectEngine } from "./connect.js";
import { demoConsole, registerConsole } from "./lib/console.js";
import { hydrateFromApi } from "./lib/hydrate.js";
import { clockHms } from "./lib/mandates.js";
import { isMock } from "./lib/mode.js";
import { isFreshBlock, shouldToastBlock } from "./lib/notify.js";
import { usePresenter } from "./lib/presenter.js";
import { connectPrincipal, wasConnected } from "./lib/principal.js";
import { useDemoToggles, useDescriptions } from "./lib/queries.js";
import { isFrozen, useScoped } from "./lib/scope.js";
import { useMedia } from "./lib/useMedia.js";
import { useShortcuts } from "./lib/useShortcuts.js";
import { railRows } from "./lib/view.js";
import { setMockHistory } from "./mock/api.js";
import { MOCK_PAYEE_NAMES } from "./mock/events.js";
import { startMock } from "./mock/player.js";
import { PLAY, SCENES } from "./mock/storyboard.js";
import { useStore } from "./store.js";

const mock = isMock();

export function App() {
  const raw = useStore();
  const state = useScoped(raw);
  const [attempt, setAttempt] = useState(0);
  const [sceneId, setSceneId] = useState(PLAY);
  const { toggle: toggleTheme } = useTheme();
  const [inspector, setInspector] = useState(false);
  const wide = useMedia("(min-width: 1280px)");
  const [mandateOpen, setMandateOpen] = useState(false);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [agentsOpen, setAgentsOpen] = useState(false);
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [blockNotice, setBlockNotice] = useState(false);
  const demoEnabled = useDemoToggles();
  useEffect(() => {
    if (!demoEnabled) {
      setConsoleOpen(false);
      return registerConsole(null);
    }
    registerConsole(() => setConsoleOpen((v) => !v));
    return () => registerConsole(null);
  }, [demoEnabled]);
  const [presenter, togglePresenter] = usePresenter();
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt is a deliberate reconnect trigger
  useEffect(() => {
    useStore.getState().reset();
    if (!mock) return connectEngine();
    useStore.getState().setPayeeNames(MOCK_PAYEE_NAMES);
    const scene = SCENES.find((x) => x.id === sceneId);
    if (!scene) return startMock();
    const st = useStore.getState();
    for (const svc of ["engine", "worker", "verifier"] as const) st.setConnection(svc, "mock");
    for (const e of scene.events) st.apply(e);
    // Same path as a real reload: the list and the task -> mandate links come from the (mock) API.
    setMockHistory(scene.history ?? null);
    void hydrateFromApi();
  }, [attempt, sceneId]);
  // A principal connected earlier in this browser session is connected again after a reload.
  useEffect(() => {
    if (wasConnected()) void connectPrincipal();
  }, []);
  const reconnect = useCallback(() => setAttempt((n) => n + 1), []);
  const descriptions = useDescriptions();
  const [newTaskSignal, setNewTaskSignal] = useState(0);
  const hasRoot = state.root !== null;
  const shortcuts = useMemo(() => {
    const move = (dir: 1 | -1) => () => {
      const st = useStore.getState();
      const k = neighbour(railRows(st), st.selected, dir);
      if (k) st.select(k);
    };
    const stepMandate = (dir: 1 | -1) => () => {
      const st = useStore.getState();
      const k = mandateNeighbour(sortedMandates(st.mandates), st.selectedMandate, dir);
      if (k && k !== st.selectedMandate) st.selectMandate(k);
    };
    return {
      n: () => (hasRoot ? setNewTaskSignal((v) => v + 1) : setWizardOpen(true)),
      Escape: () => {
        setConsoleOpen(false);
        setInspector(false);
      },
      j: move(1),
      k: move(-1),
      "[": stepMandate(-1),
      "]": stepMandate(1),
      i: () => setInspector((v) => !v),
      a: () => setAgentsOpen(true),
      m: () => (hasRoot ? setMandateOpen(true) : setWizardOpen(true)),
      d: () => demoConsole.open?.(),
      p: togglePresenter,
      "?": () => setHelpOpen(true),
      t: toggleTheme,
    };
  }, [toggleTheme, togglePresenter, hasRoot]);
  useShortcuts(shortcuts);
  const streamed = useLiveStream(!mock);
  const live = mock ? (SCENES.find((x) => x.id === sceneId)?.live ?? null) : streamed;
  const blockCount = state.blocks.length;
  const seenBlocks = useRef(0);
  const newest = state.blocks[0];
  useEffect(() => {
    const fresh = blockCount - seenBlocks.current;
    seenBlocks.current = blockCount;
    if (
      fresh > 0 &&
      newest &&
      isFreshBlock(newest.at, Date.now(), mock) &&
      shouldToastBlock(useStore.getState().selected, newest.seq)
    )
      setBlockNotice(true);
  }, [blockCount, newest]);
  const onBlockRow = state.selected?.startsWith("block:") === true;
  useEffect(() => {
    if (onBlockRow) setBlockNotice(false);
  }, [onBlockRow]);
  const selRow = raw.selectedMandate ? raw.mandates.get(raw.selectedMandate) : undefined;
  const shown =
    selRow && selRow.hash !== raw.rootHash && selRow.ceiling
      ? {
          ceiling: selRow.ceiling,
          ...(isFrozen(selRow) ? { frozenAt: clockHms(selRow.retired_at) } : {}),
        }
      : undefined;
  const down = !mock && state.connections.engine === "disconnected";
  return (
    <div className="flex h-screen flex-col bg-background text-base text-foreground">
      {mock && <MockBanner scene={sceneId} onScene={setSceneId} />}
      <TopBar
        state={state}
        root={state.root}
        inspectorOpen={inspector}
        presenter={presenter}
        onTogglePresenter={togglePresenter}
        onHelp={() => setHelpOpen(true)}
        onReconnect={reconnect}
        onMandate={() => (state.root ? setMandateOpen(true) : setWizardOpen(true))}
        onNewMandate={() => {
          setMandateOpen(false);
          setWizardOpen(true);
        }}
        onToggleInspector={() => setInspector((v) => !v)}
        onAgents={() => setAgentsOpen(true)}
        {...(shown ? { shown } : {})}
      />
      <div className="flex min-h-0 flex-1">
        {state.root && (
          <aside
            aria-label="Tasks"
            className="w-80 shrink-0 border-r border-rule-soft bg-card/40 p-3 backdrop-blur-sm"
          >
            <TaskRail
              state={state}
              descriptions={descriptions}
              live={live}
              newTask={<NewTaskButton openSignal={newTaskSignal} />}
              mandates={<MandateList />}
            />
          </aside>
        )}
        <main
          className={`grid min-w-0 flex-1 gap-6 overflow-auto p-8 [.presenter_&]:py-4 ${state.root ? "content-start" : "place-content-center"}`}
        >
          <FundsPanel />
          {blockNotice && !onBlockRow && <BlockNotice onDismiss={() => setBlockNotice(false)} />}
          {down && (
            <div
              role="alert"
              className="animate-soft-in flex items-start gap-3  border border-bad/40 bg-bad/8 p-4 shadow-soft"
            >
              <WifiOff aria-hidden className="mt-0.5 size-5 shrink-0 text-bad" />
              <div>
                <p className="text-lg font-semibold">Engine disconnected</p>
                <p>
                  Nothing on this screen is live until it reconnects. No funds can move while it is
                  down.
                </p>
              </div>
            </div>
          )}
          {state.root ? (
            <div
              key={state.selected ?? "none"}
              className="animate-soft-in  border border-rule-soft bg-card/80 p-6 shadow-soft"
            >
              <Stage state={state} live={live} descriptions={descriptions} />
            </div>
          ) : (
            <EmptyState onCreate={() => setWizardOpen(true)} />
          )}
        </main>
        {inspector && wide && (
          <aside
            aria-label="Details"
            className="w-[21.5rem] shrink-0 overflow-auto border-l border-rule-soft bg-card/40 p-4"
          >
            <Inspector mock={mock} />
          </aside>
        )}
      </div>
      {demoEnabled && <DemoConsole open={consoleOpen} onClose={() => setConsoleOpen(false)} />}
      {!wide && (
        <Sheet open={inspector} onOpenChange={setInspector}>
          <SheetContent side="right" className="overflow-auto p-4">
            <SheetHeader className="p-0">
              <SheetTitle className="text-xl">Details</SheetTitle>
              <SheetDescription>
                Technical view of the worker, the verifier and the evidence.
              </SheetDescription>
            </SheetHeader>
            <Inspector mock={mock} />
          </SheetContent>
        </Sheet>
      )}
      <AgentsPanel
        open={agentsOpen}
        onOpenChange={setAgentsOpen}
        mock={mock}
        descriptions={descriptions}
      />
      <ShortcutHelp open={helpOpen} onOpenChange={setHelpOpen} />
      <MandateWizard open={wizardOpen} onOpenChange={setWizardOpen} />
      {state.root && (
        <MandateSummary
          root={state.root}
          names={state.payeeNames}
          open={mandateOpen}
          onOpenChange={setMandateOpen}
        />
      )}
    </div>
  );
}
