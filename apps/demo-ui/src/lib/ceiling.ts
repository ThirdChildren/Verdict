import { fromMinor } from "./money.js";

/** A typed ceiling as minor units ("5" and "5.0" both read as 5.00), or null when it is not a positive amount within `precision` decimals. */
export function parseCeiling(text: string, precision: number): bigint | null {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(text.trim());
  if (!m) return null;
  const frac = m[2] ?? "";
  if (frac.length > precision) return null;
  const v =
    BigInt(m[1] as string) * 10n ** BigInt(precision) + BigInt(frac.padEnd(precision, "0") || "0");
  return v > 0n ? v : null;
}

export interface Preset {
  tasks: number;
  /** The ceiling in tUSD that covers `tasks` tasks of the per-task limit. */
  total: string;
  label: string;
}

/** "Enough for N tasks of X": the per-task limit times N. Presets above the available funds stay (warning only). */
export function presetsFor(perTask: string, precision: number, counts = [1, 3, 5]): Preset[] {
  const x = parseCeiling(perTask, precision);
  if (x === null) return [];
  return counts.map((tasks) => {
    const total = fromMinor(x * BigInt(tasks), precision);
    return { tasks, total, label: `${tasks} ${tasks === 1 ? "task" : "tasks"} of ${perTask}` };
  });
}

/** True when the ceiling is above what can be delegated. Unknown funds (null) never warn. */
export function exceedsAvailable(
  ceiling: bigint,
  availableToDelegate: string | null,
  precision: number,
): boolean {
  if (availableToDelegate === null) return false;
  const a = parseCeiling(availableToDelegate, precision);
  return ceiling > (a ?? 0n);
}

export interface SliderBounds {
  /** Whole minor units the slider spans: 0..max. */
  max: number;
  step: number;
  /** Slider position for a ceiling: pinned inside the bounds even when the ceiling is above them. */
  position: (ceiling: bigint | null) => number;
}

/** Slider 0..available_to_delegate (or, when funds are unknown, up to the drafted ceiling), one tUSD per step when wide enough. */
export function sliderBounds(
  availableToDelegate: string | null,
  fallbackMax: bigint,
  precision: number,
): SliderBounds {
  const avail =
    availableToDelegate === null ? null : (parseCeiling(availableToDelegate, precision) ?? 0n);
  const max = Number(avail ?? fallbackMax);
  const unit = 10 ** precision;
  const step = max >= 2 * unit ? unit : 1;
  return {
    max,
    step,
    position: (c) => (c === null ? 0 : Math.min(Number(c), max)),
  };
}

/** The proposal with the chosen ceiling; the per-task limit never exceeds it. */
export function withCeiling<T extends { max_total: string; max_per_task: string }>(
  proposal: T,
  ceiling: bigint,
  precision: number,
): T {
  const perTask = parseCeiling(proposal.max_per_task, precision);
  return {
    ...proposal,
    max_total: fromMinor(ceiling, precision),
    max_per_task:
      perTask !== null && perTask > ceiling ? fromMinor(ceiling, precision) : proposal.max_per_task,
  };
}
