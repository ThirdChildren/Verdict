import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { DemoConsole } from "./components/DemoConsole.js";
import { EmptyState } from "./components/EmptyState.js";
import { Inspector } from "./components/Inspector.js";
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
import { isMock } from "./lib/mode.js";
import { blockToast, isFreshBlock, shouldToastBlock } from "./lib/notify.js";
import { usePresenter } from "./lib/presenter.js";
import { useDemoToggles, useDescriptions } from "./lib/queries.js";
import { useMedia } from "./lib/useMedia.js";
import { useShortcuts } from "./lib/useShortcuts.js";
import { railRows } from "./lib/view.js";
import { startMock } from "./mock/player.js";
import { PLAY, SCENES } from "./mock/storyboard.js";
import { useStore } from "./store.js";

const mock = isMock();

export function App() {
  const state = useStore();
  const [attempt, setAttempt] = useState(0);
  const [sceneId, setSceneId] = useState(PLAY);
  const { toggle: toggleTheme } = useTheme();
  const [inspector, setInspector] = useState(false);
  const wide = useMedia("(min-width: 1280px)");
  const [mandateOpen, setMandateOpen] = useState(false);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [consoleOpen, setConsoleOpen] = useState(false);
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
    const scene = SCENES.find((x) => x.id === sceneId);
    if (!scene) return startMock();
    const st = useStore.getState();
    for (const svc of ["engine", "worker", "verifier"] as const) st.setConnection(svc, "mock");
    for (const e of scene.events) st.apply(e);
  }, [attempt, sceneId]);
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
    return {
      n: () => setNewTaskSignal((v) => v + 1),
      j: move(1),
      k: move(-1),
      i: () => setInspector((v) => !v),
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
      blockToast();
  }, [blockCount, newest]);
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
        onToggleInspector={() => setInspector((v) => !v)}
      />
      <div className="flex min-h-0 flex-1">
        {state.root && (
          <aside aria-label="Tasks" className="w-80 shrink-0 border-r border-rule p-3">
            <TaskRail
              state={state}
              descriptions={descriptions}
              live={live}
              newTask={<NewTaskButton openSignal={newTaskSignal} />}
            />
          </aside>
        )}
        <main
          className={`grid min-w-0 flex-1 gap-6 overflow-auto p-8 ${state.root ? "content-start" : "place-content-center"}`}
        >
          {down && (
            <div role="alert" className="border-y-2 border-ink p-4">
              <p className="text-lg font-semibold">Engine disconnected</p>
              <p>
                Nothing on this screen is live until it reconnects. No funds can move while it is
                down.
              </p>
            </div>
          )}
          {state.root ? (
            <div key={state.selected ?? "none"}>
              <Stage state={state} live={live} descriptions={descriptions} />
            </div>
          ) : (
            <EmptyState onCreate={() => setWizardOpen(true)} />
          )}
        </main>
        {inspector && wide && (
          <aside
            aria-label="Details"
            className="w-[21.5rem] shrink-0 overflow-auto border-l border-rule p-4"
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
