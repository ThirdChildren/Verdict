import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";

export const SHORTCUTS: { key: string; what: string }[] = [
  { key: "n", what: "New task" },
  { key: "j", what: "Next task" },
  { key: "k", what: "Previous task" },
  { key: "i", what: "Inspector (proof and raw messages)" },
  { key: "a", what: "Agents (what each agent decided and produced; press again to close)" },
  { key: "m", what: "Your mandate" },
  { key: "d", what: "Demo console (when it is available)" },
  { key: "p", what: "Presenter size (larger text for a projector)" },
  { key: "t", what: "Light or dark theme" },
  { key: "?", what: "This help" },
  { key: "Esc", what: "Close the open panel (details, demo console or dialog)" },
];

/** Keyboard shortcuts, one line each. Opened with `?`. */
export function ShortcutHelp(props: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="text-xl">Keyboard shortcuts</DialogTitle>
          <DialogDescription>Single keys. They are ignored while you type.</DialogDescription>
        </DialogHeader>
        <dl className="grid divide-y divide-rule-soft border-y border-rule">
          {SHORTCUTS.map((s) => (
            <div key={s.key} className="grid grid-cols-[4rem_1fr] items-center gap-4 py-1.5">
              <dt>
                <Kbd>{s.key}</Kbd>
              </dt>
              <dd className="text-base">{s.what}</dd>
            </div>
          ))}
        </dl>
      </DialogContent>
    </Dialog>
  );
}
