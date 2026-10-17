import { expect, test } from "vitest";
import { EventBus } from "../events.js";
import { Ledger } from "../ledger/index.js";
import { buildServer } from "../server.js";

type Row = {
  taskId: string;
  paymentHash: string;
  cltvBlocks: number | null;
  lockedHeight: number | null;
};

async function setup(enabled: boolean, status: (h: string) => string, rows: Row[]) {
  const ledger = Ledger.open(":memory:", 2);
  ledger.listPayments = () => rows;
  const bus = new EventBus();
  let height = 100;
  let mined = 0;
  const app = await buildServer({
    logger: false,
    ledger,
    bus,
    wallet: {
      paymentStatus: async (h: string) => [{ paymentHash: h, role: "payer", status: status(h) }],
      onPaymentStatus: () => () => undefined,
    } as never,
    chainHeight: async () => height,
    demo: {
      enabled,
      pauseMs: 0,
      mine: () => {
        height++;
        mined++;
      },
    },
  });
  return { app, bus, mined: () => mined };
}
const A = { taskId: "task_a", paymentHash: "a".repeat(64), cltvBlocks: 3, lockedHeight: 100 };
const B = { taskId: "task_b", paymentHash: "b".repeat(64), cltvBlocks: 3, lockedHeight: 100 };
const post = (app: Awaited<ReturnType<typeof setup>>["app"], task_id: string) =>
  app.inject({ method: "POST", url: "/api/demo/mine-until-refund", payload: { task_id } });

test("flag off: toggles say disabled and the route does not exist", async () => {
  const { app } = await setup(false, () => "Pending", [A]);
  expect((await app.inject({ method: "GET", url: "/api/demo/toggles" })).json()).toEqual({
    enabled: false,
  });
  expect((await post(app, "task_a")).statusCode).toBe(404);
  expect(app.hasRoute({ method: "POST", url: "/api/demo/mine-until-refund" })).toBe(false);
});

test("another task with a pending payment: refused 409 and nothing mined", async () => {
  const { app, mined } = await setup(true, () => "Pending", [A, B]);
  const res = await post(app, "task_a");
  expect(res.statusCode).toBe(409);
  expect(res.json()).toMatchObject({ code: "DEMO_OTHER_PAYMENT_IN_FLIGHT" });
  expect(mined()).toBe(0);
});

test("happy path: mines, streams progress, ends refunded", async () => {
  const mined = 0;
  const {
    app,
    bus,
    mined: m,
  } = await setup(
    true,
    (h) =>
      h === A.paymentHash && m() >= 3 ? "Failed" : h === B.paymentHash ? "Settled" : "Pending",
    [A, B],
  );
  void mined;
  expect((await app.inject({ method: "GET", url: "/api/demo/toggles" })).json()).toEqual({
    enabled: true,
  });
  const res = await post(app, "task_a");
  expect(res.statusCode).toBe(200);
  expect(res.json()).toMatchObject({ ok: true, refunded: true, blocks: 3 });
  expect(m()).toBe(3);
  const ev = bus.replay().filter((e) => e.type === "DEMO_MINE_PROGRESS");
  expect(ev.length).toBeGreaterThanOrEqual(4);
  expect(ev.at(-1)).toMatchObject({
    data: { task_id: "task_a", percent: 100, state: "refunded", height: 103 },
  });
});
