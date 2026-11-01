"use client"

import * as React from "react"
import { cn } from "@/lib/utils"
import { Popover as PopoverPrimitive, Tooltip as TooltipPrimitive } from "radix-ui"

// Phones and tablets can't hover, so there a tooltip opens on tap (and closes on a tap elsewhere),
// working as a small popover with the same look.
const touchScreen = typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches

function TooltipProvider({
  delayDuration = 0,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return (
    <TooltipPrimitive.Provider
      data-slot="tooltip-provider"
      delayDuration={delayDuration}
      {...props}
    />
  )
}

function Tooltip({
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  if (touchScreen) return <PopoverPrimitive.Root data-slot="tooltip" open={props.open} defaultOpen={props.defaultOpen} onOpenChange={props.onOpenChange}>{props.children}</PopoverPrimitive.Root>
  return <TooltipPrimitive.Root data-slot="tooltip" {...props} />
}

function TooltipTrigger({
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
  if (touchScreen) return <PopoverPrimitive.Trigger data-slot="tooltip-trigger" {...props} />
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />
}

function TooltipContent({
  className,
  sideOffset = 6,
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  if (touchScreen) {
    return (
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          data-slot="tooltip-content"
          sideOffset={sideOffset}
          side={props.side}
          align={props.align}
          className={cn(
            "z-50 w-fit max-w-[90vw] animate-in rounded-lg border bg-popover px-3 py-1.5 text-xs text-popover-foreground shadow-lg outline-hidden fade-in-0 zoom-in-95",
            className
          )}
        >
          {children}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    )
  }
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        className={cn(
          "z-50 w-fit origin-(--radix-tooltip-content-transform-origin) animate-in rounded-lg border bg-popover px-3 py-1.5 text-xs text-popover-foreground shadow-lg fade-in-0 zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
          className
        )}
        {...props}
      >
        {children}
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  )
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider }
