import type { ComponentProps } from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-sm border border-solid px-3 text-sm font-semibold transition-colors disabled:pointer-events-none disabled:opacity-45 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-control",
  {
    variants: {
      variant: {
        default: "border-control bg-control text-control-foreground hover:bg-slate-800",
        outline: "border-border bg-white text-slate-800 hover:bg-slate-100",
      },
      size: { default: "min-h-11", compact: "min-h-9" },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export function Button({ asChild = false, className, variant, size, ...props }:
  ComponentProps<"button"> & VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Component = asChild ? Slot : "button";
  return <Component data-slot="button" className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}
