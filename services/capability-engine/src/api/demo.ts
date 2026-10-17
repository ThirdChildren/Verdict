import type { FastifyInstance } from "fastify";
import { MAX_BLOCKS, mineUntilFailed } from "../demo-mine.js";
import type { EventBus } from "../events.js";
import type { Ledger } from "../ledger/index.js";

/** Not part of the frozen protocol: the engine's own UI event for the stage's block ring. */
export interface DemoMineProgressEvent {
  seq: number;
  at: string;
  type: "DEMO_MINE_PROGRESS";
  data: {
    task_id: string;
    height: number;
    target_height: number;
    percent: number;
    state: "mining" | "refunded" | "gave_up";
  };
}

export interface DemoRouteDeps {
  enabled: boolean;
  ledger: Ledger;
  bus: EventBus;
  now: () => Date;
  wallet: { paymentStatus(h: string): Promise<{ role: string; status: string }[]> };
  mine: () => unknown;
  chainHeight: () => Promise<number>;
  pauseMs?: number;
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const refusal = (code: string, message: string) => ({ ok: false, code, message });

export function registerDemoToggleRoutes(app: FastifyInstance, d: DemoRouteDeps): void {
  app.get("/api/demo/toggles", async () => ({ enabled: d.enabled }));
  if (!d.enabled) return;

  let running = false;
  app.post("/api/demo/mine-until-refund", async (req, reply) => {
    if (!LOOPBACK.has(req.socket.remoteAddress ?? "")) {
      reply.code(403);
      return refusal(
        "DEMO_LOCAL_ONLY",
        "This demo control only answers requests from this machine.",
      );
    }
    const taskId = (req.body as { task_id?: unknown } | null)?.task_id;
    if (typeof taskId !== "string") {
      reply.code(400);
      return refusal("DEMO_BAD_REQUEST", "Say which task to run out of time: send its task_id.");
    }
    const payments = d.ledger.listPayments();
    const target = payments.find((p) => p.taskId === taskId);
    if (!target) {
      reply.code(404);
      return refusal(
        "DEMO_TASK_UNKNOWN",
        "That task has no payment locked yet, so there is nothing to refund.",
      );
    }
    if (running) {
      reply.code(409);
      return refusal(
        "DEMO_ALREADY_MINING",
        "Blocks are already being mined for a refund. Wait for it to finish.",
      );
    }
    for (const p of payments.filter((x) => x.taskId !== taskId)) {
      const seen = await d.wallet.paymentStatus(p.paymentHash).catch(() => []);
      if (
        seen.some((e) => e.role === "payer" && (e.status === "Pending" || e.status === "Claimable"))
      ) {
        reply.code(409);
        return refusal(
          "DEMO_OTHER_PAYMENT_IN_FLIGHT",
          "Another task still has money locked in flight. Mining blocks now would also expire that payment, so the demo control is refused.",
        );
      }
    }
    running = true;
    try {
      const start = await d.chainHeight();
      const target_height =
        target.lockedHeight !== null && target.cltvBlocks !== null
          ? Math.max(target.lockedHeight + target.cltvBlocks, start + 1)
          : start + MAX_BLOCKS;
      const emit = (height: number, state: "mining" | "refunded" | "gave_up") =>
        d.bus.publish(
          {
            type: "DEMO_MINE_PROGRESS",
            data: {
              task_id: taskId,
              height,
              target_height,
              percent:
                state === "refunded"
                  ? 100
                  : Math.min(
                      99,
                      Math.floor(((height - start) / Math.max(1, target_height - start)) * 100),
                    ),
              state,
            },
          },
          d.now(),
        );
      const r = await mineUntilFailed(d.wallet, target.paymentHash, {
        mine: d.mine,
        pauseMs: d.pauseMs ?? 400,
        onProgress: (blocks) => emit(start + blocks, "mining"),
      });
      emit(start + r.blocks, r.failed ? "refunded" : "gave_up");
      return { ok: true, refunded: r.failed, blocks: r.blocks, seconds: r.seconds };
    } finally {
      running = false;
    }
  });
}
