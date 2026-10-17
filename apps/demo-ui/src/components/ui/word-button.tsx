import type * as React from "react";
import { cn } from "@/lib/utils";

/** A control that is a word: underlined text, no box, no icon. Pressed or current state is bold with an ink rule. */
function WordButton({ className, ...props }: React.ComponentProps<"button">) {
  return (
    <button
      type="button"
      data-slot="word-button"
      className={cn(
        "cursor-pointer text-sm whitespace-nowrap text-ink uppercase underline decoration-rule decoration-1 underline-offset-4 outline-none hover:decoration-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring aria-pressed:font-semibold aria-pressed:decoration-2 aria-pressed:decoration-ink",
        className,
      )}
      {...props}
    />
  );
}

export { WordButton };
