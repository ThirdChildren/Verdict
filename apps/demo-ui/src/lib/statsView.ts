/** Ten-cell ink bar for a rate in 0..1 (filled = share). No colour: the glyph carries it. */
export function glyphBar(rate: number): string {
  const n = Math.max(0, Math.min(10, Math.round(rate * 10)));
  return "■".repeat(n) + "□".repeat(10 - n);
}
export const pct = (r: number | null): string => (r === null ? "—" : `${Math.round(r * 100)}%`);
export const seconds = (ms: number | null): string =>
  ms === null ? "—" : `${(ms / 1000).toFixed(1)} s`;
