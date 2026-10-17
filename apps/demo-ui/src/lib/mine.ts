import { z } from "zod";
import type { ChainInfo } from "./queries.js";

/** The engine's own UI event for "Mine until refund" (not part of the frozen protocol). */
export const mineEventSchema = z.object({
  type: z.literal("DEMO_MINE_PROGRESS"),
  data: z.object({
    task_id: z.string(),
    height: z.number(),
    target_height: z.number(),
    percent: z.number(),
    state: z.enum(["mining", "refunded", "gave_up"]),
  }),
});
export type MineProgress = z.infer<typeof mineEventSchema>["data"];

/** Returns the progress when a raw frame is a DEMO_MINE_PROGRESS event, else null. */
export function parseMineEvent(raw: unknown): MineProgress | null {
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  const r = mineEventSchema.safeParse(value);
  return r.success ? r.data.data : null;
}

/** The block ring while blocks are being mined on purpose: the live height wins over the polled one. */
export function ringWithMining(
  chain: ChainInfo | null,
  mine: MineProgress | undefined,
): ChainInfo | null {
  if (!mine || mine.state !== "mining") return chain;
  if (chain) return { ...chain, height: mine.height, expiresAt: mine.target_height };
  const p = Math.min(0.99, Math.max(0, mine.percent / 100));
  const lockedAt = Math.round((mine.height - p * mine.target_height) / (1 - p));
  return { height: mine.height, lockedAt, expiresAt: mine.target_height };
}

/** Plain-language explanations of why "Mine until refund" was refused. */
export const MINE_ERRORS: Record<string, string> = {
  DEMO_LOCAL_ONLY:
    "Only the machine that runs the engine may do this. Open the console on that machine.",
  DEMO_BAD_REQUEST: "Select a task in the list first, then try again.",
  DEMO_TASK_UNKNOWN: "The engine does not know this task. Select another one.",
  DEMO_ALREADY_MINING: "Blocks are already being mined for this demo. Wait until it finishes.",
  DEMO_OTHER_PAYMENT_IN_FLIGHT:
    "Another payment is still in progress. Mining now would expire it too. Let it finish first.",
};
export const mineErrorText = (code: string, fallback: string): string =>
  MINE_ERRORS[code] ?? fallback;
