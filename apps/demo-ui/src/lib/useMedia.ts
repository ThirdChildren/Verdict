import { useEffect, useState } from "react";

export function useMedia(query: string): boolean {
  const get = () => typeof matchMedia === "function" && matchMedia(query).matches;
  const [match, setMatch] = useState(get);
  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const mq = matchMedia(query);
    const on = () => setMatch(mq.matches);
    mq.addEventListener("change", on);
    on();
    return () => mq.removeEventListener("change", on);
  }, [query]);
  return match;
}
