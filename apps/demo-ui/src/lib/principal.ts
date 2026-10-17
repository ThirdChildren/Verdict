import { type PrincipalState, useStore } from "../store.js";
import { fetchPrincipal } from "./api.js";

const REMEMBER = "verdict.principal";

/** `eip191:0x…abcd`: the scheme and the last four characters of the address. Anything else is middle-truncated. */
export function shortPrincipal(id: string): string {
  const m = /^(eip191:0x)[0-9a-f]{40}$/.exec(id);
  if (m) return `${m[1]}…${id.slice(-4)}`;
  return id.length <= 15 ? id : `${id.slice(0, 8)}…${id.slice(-4)}`;
}

/** The chip text of a connected principal. The key is held by the signer process; this is its public id. */
export const principalChip = (id: string): string =>
  `Principal · WDK · ${shortPrincipal(id)} · regtest`;

const remember = (on: boolean): void => {
  try {
    if (on) sessionStorage.setItem(REMEMBER, "1");
    else sessionStorage.removeItem(REMEMBER);
  } catch {
    // private window or blocked storage: the connection simply is not restored after a reload
  }
};
export const wasConnected = (): boolean => {
  try {
    return sessionStorage.getItem(REMEMBER) === "1";
  } catch {
    return false;
  }
};

/** Asks the engine for the principal's public id (it checks with the signer). No wallet picker, no fake providers. */
export async function connectPrincipal(): Promise<PrincipalState> {
  const set = useStore.getState().setPrincipal;
  set({ status: "connecting" });
  try {
    const { id } = await fetchPrincipal();
    remember(true);
    const next: PrincipalState = { status: "connected", id };
    set(next);
    return next;
  } catch (e) {
    remember(false);
    const next: PrincipalState = {
      status: "error",
      message: e instanceof Error ? e.message : "The principal could not be connected.",
    };
    set(next);
    return next;
  }
}

export function disconnectPrincipal(): void {
  remember(false);
  useStore.getState().setPrincipal({ status: "disconnected" });
}
