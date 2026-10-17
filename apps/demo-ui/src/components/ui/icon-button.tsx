import type { LucideIcon } from "lucide-react";
import type * as React from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/** A square icon-only control with a tooltip. `label` is both the accessible name and the tooltip text. */
export function IconButton({
  icon: Icon,
  label,
  hint,
  className,
  ...props
}: Omit<React.ComponentProps<"button">, "children"> & {
  icon: LucideIcon;
  label: string;
  /** Extra tooltip text, e.g. the shortcut key. */
  hint?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          className={cn(
            "inline-flex size-9 shrink-0 items-center justify-center rounded-lg text-ink outline-none transition duration-150 hover:bg-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:scale-95 aria-pressed:bg-surface aria-pressed:shadow-soft disabled:opacity-50",
            className,
          )}
          {...props}
        >
          <Icon aria-hidden className="size-[1.15rem]" strokeWidth={1.75} />
        </button>
      </TooltipTrigger>
      <TooltipContent>{hint ? `${label} (${hint})` : label}</TooltipContent>
    </Tooltip>
  );
}
