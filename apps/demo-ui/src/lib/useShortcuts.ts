import { useEffect } from "react";

const typing = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));

/** Single-key shortcuts. Ignored while typing, with modifiers held, or while a dialog is open. */
export function useShortcuts(map: Record<string, () => void>) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || typing(e.target)) return;
      if (document.querySelector('[role="dialog"]')) return;
      const fn = map[e.key];
      if (fn) {
        e.preventDefault();
        fn();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [map]);
}
