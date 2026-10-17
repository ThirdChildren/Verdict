import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";
import type * as React from "react";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 border border-transparent text-base font-semibold whitespace-nowrap outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        default: "border-primary bg-primary text-primary-foreground hover:bg-ink hover:border-ink",
        destructive: "border-ink bg-ink text-paper hover:bg-paper hover:text-ink",
        outline: "border-ink bg-paper text-ink hover:bg-surface",
        secondary: "border-rule bg-surface text-ink hover:border-ink",
        ghost: "text-ink hover:bg-surface",
        link: "text-ink underline underline-offset-4 hover:no-underline",
      },
      size: {
        default: "h-11 px-5 py-2",
        xs: "h-7 gap-1 px-2 text-sm",
        sm: "h-9 gap-1.5 px-3",
        lg: "h-12 px-6",
        icon: "size-11",
        "icon-xs": "size-6",
        "icon-sm": "size-9",
        "icon-lg": "size-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  }) {
  const Comp = asChild ? Slot.Root : "button";

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
