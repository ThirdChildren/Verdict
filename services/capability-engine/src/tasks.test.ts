import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { EventBus } from "./events.js";
import { TaskTracker } from "./tasks.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const stopped = (bus: EventBus) => bus.replay().filter((e) => e.type === "WORKER_STATUS");

test("a locked task with no delivery for the silence window tells the UI the worker stopped", () => {
  const bus = new EventBus();
  const t = new TaskTracker(bus, () => new Date(), 20_000);
  t.move("task_a", "ACCEPTED");
  t.move("task_a", "P_DEPOSITED");
  t.move("task_a", "P_CONFIRMED");
  t.move("task_a", "INVOICE_RECEIVED");
  t.move("task_a", "ESCROW_LOCKED");
  vi.advanceTimersByTime(19_999);
  expect(stopped(bus)).toHaveLength(0);
  vi.advanceTimersByTime(1);
  expect(stopped(bus)).toMatchObject([
    { data: { task_id: "task_a", worker_status: "stopped", silent_seconds: 20 } },
  ]);
  expect(t.current("task_a")).toBe("ESCROW_LOCKED"); // display only: no state or money change
});

test("a delivery before the window cancels the warning", () => {
  const bus = new EventBus();
  const t = new TaskTracker(bus, () => new Date(), 1_000);
  for (const s of [
    "ACCEPTED",
    "P_DEPOSITED",
    "P_CONFIRMED",
    "INVOICE_RECEIVED",
    "ESCROW_LOCKED",
    "DELIVERED",
  ] as const)
    t.move("task_b", s);
  vi.advanceTimersByTime(5_000);
  expect(stopped(bus)).toHaveLength(0);
});
