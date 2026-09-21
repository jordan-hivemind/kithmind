"use client";

import * as RadixTooltip from "@radix-ui/react-tooltip";
import type { ComponentPropsWithoutRef } from "react";

type TooltipProviderProps = ComponentPropsWithoutRef<
  typeof RadixTooltip.Provider
>;
type TooltipProps = ComponentPropsWithoutRef<typeof RadixTooltip.Root>;

/** The delay is deliberately not configurable. Every app tooltip is immediate
 * for pointer and keyboard users, including a future consumer that does not
 * add an outer provider. */
export function TooltipProvider(props: TooltipProviderProps) {
  return (
    <RadixTooltip.Provider {...props} delayDuration={0} skipDelayDuration={0} />
  );
}

/** Includes its own provider so the immediate-open policy holds by default. */
export function Tooltip(props: TooltipProps) {
  return (
    <TooltipProvider>
      <RadixTooltip.Root {...props} delayDuration={0} />
    </TooltipProvider>
  );
}
export const TooltipTrigger = RadixTooltip.Trigger;

type TooltipContentProps = ComponentPropsWithoutRef<
  typeof RadixTooltip.Content
>;

/**
 * The app's one tooltip surface. It opens immediately for both pointer and
 * keyboard focus, and Radix keeps it within the viewport when space is tight.
 */
export function TooltipContent({
  className = "",
  sideOffset = 6,
  collisionPadding = 12,
  ...props
}: TooltipContentProps) {
  return (
    <RadixTooltip.Portal>
      <RadixTooltip.Content
        {...props}
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        className={`z-50 max-w-sm rounded-panel border border-gray-700 bg-white px-3 py-2 text-[14.5px] leading-snug text-gray-700 shadow-[var(--kith-shadow-md)] ${className}`}
      />
    </RadixTooltip.Portal>
  );
}
