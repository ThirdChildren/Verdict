import { useStore } from "../store.js";
import { fetchMandates, fetchTaskRoots } from "./api.js";

/**
 * Rebuilds the mandate list and the task -> mandate links from the engine's read model (once per connect).
 * Live events then keep them current. A failure leaves the live-built rows in place.
 */
export async function hydrateFromApi(): Promise<void> {
  try {
    const [rows, roots] = await Promise.all([fetchMandates(), fetchTaskRoots()]);
    useStore.getState().hydrate(rows, roots);
  } catch (err) {
    console.warn("mandate history unavailable", err instanceof Error ? err.message : err);
  }
}
