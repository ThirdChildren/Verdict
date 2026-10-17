import { useId } from "react";
import { Label } from "@/components/ui/label";
import { PLAY, SCENES } from "../mock/storyboard.js";

/** Always visible in ?mock=1. The storyboard select renders each UI state without the live stack. */
export function MockBanner(props: { scene: string; onScene: (id: string) => void }) {
  const id = useId();
  return (
    <div
      role="status"
      className="flex items-center justify-center gap-4 bg-warn-soft px-6 py-1 text-sm text-warn-soft-foreground"
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
        className="rounded border bg-card px-2 py-1 text-sm text-foreground"
      >
        <option value={PLAY}>11 · Play recorded stream (timed)</option>
        {SCENES.map((s) => (
          <option key={s.id} value={s.id}>
            {s.label}
          </option>
        ))}
      </select>
    </div>
  );
}
