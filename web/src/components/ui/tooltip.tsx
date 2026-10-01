import { Tooltip as TooltipPrimitive } from "@kobalte/core/tooltip";
import type { TooltipContentProps as PrimitiveContentProps } from "@kobalte/core/tooltip";
import type { PolymorphicProps } from "@kobalte/core/polymorphic";
import { omit } from "solid-js";
import { cx } from "./utils";

export const Tooltip = TooltipPrimitive;
export const TooltipTrigger = TooltipPrimitive.Trigger;
export type TooltipContentProps = PolymorphicProps<
  "div",
  PrimitiveContentProps
>;

export function TooltipContent(props: TooltipContentProps) {
  const rest = omit(props, "class");
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        {...rest}
        class={cx("ui-tooltip", props.class)}
      />
    </TooltipPrimitive.Portal>
  );
}
