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
  { key: "m", what: "Your mandate" },
  { key: "d", what: "Demo console (when it is available)" },
  { key: "p", what: "Presenter size (larger text for a projector)" },
  { key: "t", what: "Light or dark theme" },
  { key: "?", what: "This help" },
];

/** Keyboard shortcuts, one line each. Opened with `?`. */
export function ShortcutHelp(props: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-2xl">Keyboard shortcuts</DialogTitle>
          <DialogDescription>Single keys. They are ignored while you type.</DialogDescription>
        </DialogHeader>
        <dl className="grid gap-2">
          {SHORTCUTS.map((s) => (
            <div key={s.key} className="flex items-center gap-4">
              <dt className="w-8">
                <Kbd className="h-7 min-w-7 text-sm">{s.key}</Kbd>
              </dt>
              <dd className="text-base">{s.what}</dd>
            </div>
          ))}
        </dl>
      </DialogContent>
    </Dialog>
  );
}
