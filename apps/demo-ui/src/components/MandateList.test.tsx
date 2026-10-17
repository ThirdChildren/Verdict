// @vitest-environment jsdom

import { cleanup, render, renderHook, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { UiEvent } from "@verdict/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseMandates, parseTaskRoots } from "../lib/mandates.js";
import { mandateOfTask, scopeLists, useScoped } from "../lib/scope.js";
import { railRows } from "../lib/view.js";
import { SCENES } from "../mock/storyboard.js";
import { initialState, reduce, useStore } from "../store.js";
import { MandateList, mandateNeighbour, sortedMandates } from "./MandateList.js";
import { SHORTCUTS } from "./ShortcutHelp.js";

afterEach(cleanup);
beforeEach(() => useStore.setState({ ...initialState, mandates: new Map() }));

const scene = SCENES.find((s) => s.id === "mandates-history");
if (!scene?.history) throw new Error("scene missing");
const history = scene.history;
const loaded = () => {
  const s = scene.events.reduce(reduce, initialState);
  useStore.setState({ ...s });
  useStore
    .getState()
    .hydrate(parseMandates(history.mandates), parseTaskRoots({ tasks: history.tasks }));
  return useStore.getState();
};

describe("mandate list", () => {
  it("renders one row per mandate, newest first, with the status word and the glyph", () => {
    loaded();
    render(<MandateList />);
    const [b, a] = within(screen.getByRole("navigation", { name: "Mandates" })).getAllByRole(
      "button",
    );
    expect(b?.textContent).toMatch(/02■ ACTIVE1 task5\.00 · 2\.00\/task/);
    expect(a?.textContent).toMatch(/01□ RETIRED2 tasks\d\d:\d\d · 5\.00/);
    expect(b?.getAttribute("aria-current")).toBe("true");
    expect(a?.getAttribute("aria-current")).toBeNull();
  });
  it("selects on click and Enter", async () => {
    const s = loaded();
    render(<MandateList />);
    const rows = screen.getAllByRole("button");
    await userEvent.click(rows[1] as HTMLElement);
    expect(useStore.getState().selectedMandate).toBe(sortedMandates(s.mandates)[1]?.hash);
    (rows[0] as HTMLElement).focus();
    await userEvent.keyboard("{Enter}");
    expect(useStore.getState().selectedMandate).toBe(sortedMandates(s.mandates)[0]?.hash);
  });
  it("shows an empty line without mandates", () => {
    render(<MandateList />);
    expect(screen.getByText("No mandate yet.")).toBeTruthy();
  });
  it("lists [ and ] in the shortcut help and clamps at the ends", () => {
    expect(SHORTCUTS.map((s) => s.key)).toEqual(expect.arrayContaining(["[", "]"]));
    const rows = sortedMandates(loaded().mandates);
    expect(mandateNeighbour(rows, rows[0]?.hash ?? null, -1)).toBe(rows[0]?.hash);
    expect(mandateNeighbour(rows, rows[0]?.hash ?? null, 1)).toBe(rows[1]?.hash);
    expect(mandateNeighbour([], null, 1)).toBeNull();
  });
});

describe("mandate scope", () => {
  it("keeps tasks of the selected mandate only, and the frozen figures of a retired one", () => {
    const s = loaded();
    const [active, retired] = sortedMandates(s.mandates);
    expect(active && Object.keys(scopeLists(s, active.hash).tasks)).toHaveLength(1);
    useStore.getState().selectMandate(retired?.hash ?? "");
    const { result } = renderHook(() => useScoped(useStore.getState()));
    expect(Object.keys(result.current.tasks)).toHaveLength(2);
    expect(result.current.budget).toMatchObject({
      committed: "1.20",
      reserved: "0.00",
      remaining: "3.80",
    });
    expect(railRows(result.current).map((r) => r.chip)).toEqual(["Refunded", "Paid"]);
  });
  it("selectMandate moves the stage selection to the newest task of that mandate", () => {
    const s = loaded();
    useStore.getState().selectMandate(sortedMandates(s.mandates)[1]?.hash ?? "");
    expect(useStore.getState().selected).toBe("task_bbbbbbbbbbbbbbbb");
  });
  it("a new root (after the retirement) selects itself and empties the rail", () => {
    const s = loaded();
    useStore.getState().selectMandate(sortedMandates(s.mandates)[1]?.hash ?? "");
    const root = s.root;
    if (!root) throw new Error("no root");
    const next = reduce(useStore.getState(), {
      seq: s.lastSeq + 1,
      at: "2026-10-18T18:00:00Z",
      type: "CAP_ROOT",
      data: { ...root, cap_id: "cap_9999999999999999" },
    } as UiEvent);
    expect(next.selectedMandate).toBe(next.rootHash);
    expect(next.selectedMandate).not.toBe(s.rootHash);
    expect(next.selected).toBeNull();
    expect([...next.mandates.values()].filter((r) => r.status === "retired")).toHaveLength(2);
    const scoped = scopeLists(next, next.selectedMandate);
    expect(railRows({ ...next, ...scoped })).toHaveLength(0);
  });
  it("an event for an unknown mandate creates its row lazily; unknown task falls back to the live root", () => {
    const s = loaded();
    expect(mandateOfTask(s, "task_unknown")).toBe(s.rootHash);
    useStore.getState().hydrate([], { task_zzz: "f".repeat(64) });
    expect(useStore.getState().taskRoots.task_zzz).toBe("f".repeat(64));
  });
});

describe("mandate API boundary", () => {
  it("skips a row with a missing field, ignores unknown fields, never throws", () => {
    const good = (history.mandates as { mandates: Record<string, unknown>[] }).mandates[0];
    const warn = console.warn;
    console.warn = () => {};
    try {
      const rows = parseMandates({
        mandates: [{ ...good, extra: 1 }, { ...good, figures: undefined }, 7, null],
      });
      expect(rows).toHaveLength(1);
      expect(parseMandates("nope")).toEqual([]);
    } finally {
      console.warn = warn;
    }
  });
});

describe("rail scoping performance (AC8)", () => {
  const perf = process.env.SKIP_PERF === "1" ? it.skip : it;
  perf(
    "50 tasks across 5 mandates: rail rows and render stay fast; a budget frame keeps identities",
    async () => {
      const base = scene.events[0] as UiEvent;
      if (base.type !== "CAP_ROOT") throw new Error("root");
      let seq = 0;
      let s = initialState;
      for (let m = 0; m < 5; m++) {
        s = reduce(s, {
          ...base,
          seq: seq++,
          data: { ...base.data, cap_id: `cap_${String(m).repeat(16)}` },
        });
        for (let t = 0; t < 10; t++)
          s = reduce(s, {
            seq: seq++,
            at: "2026-10-18T15:40:00Z",
            type: "TASK_STATE",
            data: { task_id: `task_${m}${t}`.padEnd(21, "0"), state: "ESCROW_LOCKED" },
          });
      }
      useStore.setState({ ...s });
      const { TaskRail } = await import("./TaskRail.js");
      const hook = renderHook(() => useScoped(useStore.getState()));
      expect(Object.keys(hook.result.current.tasks)).toHaveLength(10);
      const t0 = performance.now();
      const rows = railRows(hook.result.current);
      const rowsMs = performance.now() - t0;
      const t1 = performance.now();
      render(<TaskRail state={hook.result.current} descriptions={{}} newTask={null} />);
      const renderMs = performance.now() - t1;
      expect(rows).toHaveLength(10);
      expect(rowsMs).toBeLessThan(50);
      expect(renderMs).toBeLessThan(500);
      // A BUDGET_UPDATED frame leaves the scoped lists untouched, so the rail does not rebuild.
      const before = hook.result.current;
      const live = useStore.getState();
      const after = reduce(live, {
        seq: seq++,
        at: "2026-10-18T15:41:00Z",
        type: "BUDGET_UPDATED",
        data: {
          cap_id: live.root?.cap_id ?? "",
          remaining: "1.00",
          reserved: "0.00",
          committed: "0.00",
        },
      });
      useStore.setState({ ...after });
      hook.rerender();
      expect(hook.result.current.tasks).toBe(before.tasks);
      expect(hook.result.current.blocks).toBe(before.blocks);
    },
  );
});

describe("mandate word in the header", () => {
  it("describes the selected mandate", async () => {
    const { selectedWord } = await import("./MandatePill.js");
    const [active, retired] = sortedMandates(loaded().mandates);
    expect(selectedWord(active, Date.now())).toBeNull();
    expect(selectedWord(retired, Date.now())).toMatch(/^Mandate · retired \d\d:\d\d$/);
    expect(
      selectedWord(retired && { ...retired, status: "expired", retired_at: null }, Date.now()),
    ).toBe("Mandate · expired");
  });
});

describe("E29 QA additions", () => {
  it("AC7: MANDATE_RETIRED then CAP_ROOT selects the new mandate; the rail shows none of the old tasks", () => {
    const s = loaded();
    const [, retired] = sortedMandates(s.mandates);
    useStore.getState().selectMandate(retired?.hash ?? "");
    expect(Object.keys(scopeLists(useStore.getState(), retired?.hash ?? null).tasks)).toHaveLength(
      2,
    );
    const root = s.root;
    if (!root) throw new Error("no root");
    const newId = "cap_8888888888888888";
    useStore.getState().retire({
      cap_hash: newId,
      retired: [root.cap_id],
      reason: "The previous mandate was retired.",
    });
    expect(useStore.getState().selectedMandate).toBe(retired?.hash); // retirement alone never moves it
    const next = reduce(useStore.getState(), {
      seq: useStore.getState().lastSeq + 1,
      at: "2026-10-18T18:00:00Z",
      type: "CAP_ROOT",
      data: { ...root, cap_id: newId },
    } as UiEvent);
    expect(next.selectedMandate).toBe(next.rootHash);
    expect(next.selectedMandate).not.toBe(s.rootHash);
    expect(railRows({ ...next, ...scopeLists(next, next.selectedMandate) })).toHaveLength(0);
    expect(next.selected).toBeNull();
  });
  it("AC9: hydration with malformed rows keeps the good ones and does not throw", () => {
    useStore.setState({ ...initialState, mandates: new Map() });
    const good = (history.mandates as { mandates: Record<string, unknown>[] }).mandates;
    const warn = console.warn;
    console.warn = () => {};
    try {
      const bad = [
        { ...good[0], figures: undefined },
        { ...good[1], hash: undefined },
        { ...good[1], figures: { paid: "1.20" } },
      ];
      const mixed = { mandates: [bad[0], good[0], bad[1], bad[2], good[1]] };
      expect(() =>
        useStore.getState().hydrate(parseMandates(mixed), parseTaskRoots({ tasks: [{}, null, 3] })),
      ).not.toThrow();
      const hashes = [...useStore.getState().mandates.keys()].sort();
      expect(hashes).toEqual([good[0]?.hash, good[1]?.hash].sort());
    } finally {
      console.warn = warn;
    }
  });
});
