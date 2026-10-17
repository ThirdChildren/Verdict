import { cn } from "@/lib/utils";

/** Static placeholder bar: a ruled block, no pulsing. */
function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="skeleton" className={cn("bg-surface", className)} {...props} />;
}

export { Skeleton };
