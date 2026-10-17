/**
 * Shortest mandate the screen will let you sign. The engine itself only needs the mandate to outlast the task
 * deadline (the planner proposes 1-2 h for the demo task), so 2 h is the least that keeps one task workable.
 * This is a screen guard; the engine's rules are unchanged.
 */
export const MIN_MANDATE_MINUTES = 120;

export interface DurationCheck {
  ok: boolean;
  minutesLeft: number;
}

export function mandateDuration(expiresAt: string, now: Date = new Date()): DurationCheck {
  const t = Date.parse(expiresAt);
  const minutesLeft = Number.isFinite(t) ? Math.floor((t - now.getTime()) / 60_000) : 0;
  return { ok: minutesLeft >= MIN_MANDATE_MINUTES, minutesLeft };
}
