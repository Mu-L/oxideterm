// Copyright (C) 2026 AnalyseDeCircuit
// SPDX-License-Identifier: GPL-3.0-only

import * as React from "react"
import { cn } from "../../lib/utils"

export interface InputProps
  extends React.InputHTMLAttributes<HTMLInputElement> { }

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, ...props }, ref) => {
    // WKWebView may otherwise autocapitalize technical values like SSH usernames.
    return (
      <input
        type={type}
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        className={cn(
          "flex h-9 w-full rounded-md border border-theme-border/50 bg-theme-bg/50 px-3 py-1 text-sm shadow-sm transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-theme-text-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-theme-accent focus-visible:border-theme-accent disabled:cursor-not-allowed disabled:opacity-50 text-theme-text",
          className
        )}
        ref={ref}
        {...props}
      />
    )
  }
)
Input.displayName = "Input"

export { Input }
