import { useEffect, useId } from "react";
import { Label } from "@/components/ui/label";
import { PLAY, SCENES } from "../mock/storyboard.js";

/** Always visible in ?mock=1: a plain inverted line. The storyboard select renders each UI state without the live stack. */
export function MockBanner(props: { scene: string; onScene: (id: string) => void }) {
  const id = useId();
  // Dialogs sit just below this banner (index.css), so it stays readable over them.
  useEffect(() => {
    document.documentElement.classList.add("mock");
    return () => document.documentElement.classList.remove("mock");
  }, []);
  return (
    <div
      role="status"
      className="relative z-[60] flex h-9 shrink-0 items-center justify-center gap-4 bg-ink px-6 text-sm text-paper"
    >
      <span className="font-semibold">
        MOCK DATA: recorded sample. Nothing here is a real payment.
      </span>
      <Label htmlFor={id} className="text-sm">
        Storyboard
      </Label>
      <select
        id={id}
        value={props.scene}
        onChange={(e) => props.onScene(e.target.value)}
        className="border border-paper bg-ink px-2 py-1 text-sm text-paper"
      >
        <option value={PLAY}>12 · Play recorded stream (timed)</option>
        {SCENES.map((s) => (
          <option key={s.id} value={s.id}>
            {s.label}
          </option>
        ))}
      </select>
    </div>
  );
}
