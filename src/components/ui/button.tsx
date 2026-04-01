// Copyright (C) 2026 AnalyseDeCircuit
// SPDX-License-Identifier: GPL-3.0-only

import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "../../lib/utils"

const buttonVariants = cva(
  "inline-flex items-center justify-center whitespace-nowrap text-sm font-medium transition-[color,background-color,border-color,box-shadow,opacity,transform] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-theme-accent/70 focus-visible:ring-offset-1 focus-visible:ring-offset-theme-bg disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        default:
          "bg-theme-text text-theme-bg hover:opacity-90 active:scale-[0.97] shadow-none border border-transparent",
        secondary:
          "bg-theme-bg-panel text-theme-text border border-theme-border shadow-sm hover:bg-theme-bg-hover hover:border-theme-border-strong active:scale-[0.97]",
        outline:
          "border border-theme-border bg-transparent hover:bg-theme-bg-hover hover:border-theme-border-strong active:scale-[0.97] text-theme-text",
        ghost: "hover:bg-theme-bg-hover hover:text-theme-text text-theme-text",
        destructive:
          "bg-theme-error/90 text-white hover:bg-theme-error active:scale-[0.97] border border-theme-error/80",
        link: "text-theme-text underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2",
        sm: "h-8 px-3 text-xs",
        lg: "h-10 px-8",
        icon: "h-9 w-9",
      },
      radius: {
        none: "rounded-none",
        sm: "rounded-sm",
        md: "rounded-md",
      }
    },
    defaultVariants: {
      variant: "secondary",
      size: "default",
      radius: "md",
    },
  }
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
  VariantProps<typeof buttonVariants> {
  asChild?: boolean
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, radius, ...props }, ref) => {
    return (
      <button
        className={cn(buttonVariants({ variant, size, radius, className }))}
        ref={ref}
        {...props}
      />
    )
  }
)
Button.displayName = "Button"

export { Button, buttonVariants }
