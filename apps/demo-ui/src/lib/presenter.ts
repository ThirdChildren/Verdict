import { useCallback, useEffect, useState } from "react";

const KEY = "verdict-presenter";

/** Presenter size: ~125% type for projectors, via a class on <html> (all sizes are rem). Persisted. */
export function usePresenter(): [boolean, () => void] {
  const [on, setOn] = useState(() => {
    try {
      return localStorage.getItem(KEY) === "1";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    document.documentElement.classList.toggle("presenter", on);
    try {
      localStorage.setItem(KEY, on ? "1" : "0");
    } catch {
      // storage unavailable: the choice just does not persist
    }
  }, [on]);
  return [on, useCallback(() => setOn((v) => !v), [])];
}
