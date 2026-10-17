import { useSyncExternalStore } from "react";

/** Open state of the STATS panel, shared by the key `s`, the Verifier lane word and the Inspector link. */
let open = false;
const subs = new Set<() => void>();
export function setStatsOpen(v: boolean): void {
  open = v;
  for (const f of subs) f();
}
export const toggleStats = () => setStatsOpen(!open);
export function useStatsOpen(): boolean {
  return useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => open,
  );
}
