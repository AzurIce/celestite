import { ContextMenu as MenuPrimitive } from "@kobalte/core/context-menu";
import type {
  ContextMenuContentProps as PrimitiveContentProps,
  ContextMenuItemProps as PrimitiveItemProps,
  ContextMenuSeparatorProps as PrimitiveSeparatorProps,
} from "@kobalte/core/context-menu";
import type { PolymorphicProps } from "@kobalte/core/polymorphic";
import { omit } from "solid-js";
import { cx } from "./utils";

export const ContextMenu = MenuPrimitive;
export const ContextMenuTrigger = MenuPrimitive.Trigger;
export type ContextMenuContentProps = PolymorphicProps<
  "div",
  PrimitiveContentProps
>;
export type ContextMenuItemProps = PolymorphicProps<"div", PrimitiveItemProps>;
export type ContextMenuSeparatorProps = PolymorphicProps<
  "hr",
  PrimitiveSeparatorProps
>;

export function ContextMenuContent(props: ContextMenuContentProps) {
  const rest = omit(props, "class");
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Content {...rest} class={cx("ui-menu", props.class)} />
    </MenuPrimitive.Portal>
  );
}

export function ContextMenuItem(props: ContextMenuItemProps) {
  const rest = omit(props, "class");
  return (
    <MenuPrimitive.Item {...rest} class={cx("ui-menu-item", props.class)} />
  );
}

export function ContextMenuSeparator(props: ContextMenuSeparatorProps) {
  const rest = omit(props, "class");
  return (
    <MenuPrimitive.Separator
      {...rest}
      class={cx("ui-menu-separator", props.class)}
    />
  );
}
