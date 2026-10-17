import type * as React from "react";
import { cn } from "@/lib/utils";

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "h-11 w-full min-w-0 border border-input bg-paper px-3 py-1 text-base text-ink outline-none selection:bg-primary selection:text-primary-foreground placeholder:text-muted-foreground disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50",
        "focus-visible:border-ink focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-ring",
        "aria-invalid:border-2 aria-invalid:border-ink",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
