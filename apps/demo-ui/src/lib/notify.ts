/** The notice only helps when the Blocked row is not already on screen. */
export const shouldToastBlock = (selected: string | null, blockSeq: number): boolean =>
  selected !== `block:${blockSeq}`;

/** A reconnect may replay old history: only blocks from the last two minutes (or any in mock mode) raise a notice. */
export function isFreshBlock(at: string, now: number, mock: boolean): boolean {
  return mock || now - Date.parse(at) < 120_000;
}
