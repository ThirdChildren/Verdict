/**
 * Hook for the demo console (key `d`). The console registers its opener here when it mounts; until then the key
 * does nothing and the help dialog says the console is not available.
 */
export const demoConsole: { open: (() => void) | null } = { open: null };

export function registerConsole(open: (() => void) | null): void {
  demoConsole.open = open;
}
