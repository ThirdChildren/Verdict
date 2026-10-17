import { useStore } from "../store.js";
import { MOCK_EVENTS } from "./events.js";

/** Replays the recorded stream into the store. Returns a stop function. */
export function startMock(intervalMs = 1500): () => void {
  const st = useStore.getState();
  st.setConnection("engine", "mock");
  st.setConnection("worker", "mock");
  st.setConnection("verifier", "mock");
  let i = 0;
  const t = setInterval(() => {
    const e = MOCK_EVENTS[i++];
    if (!e) return clearInterval(t);
    useStore.getState().apply(e);
  }, intervalMs);
  return () => clearInterval(t);
}
