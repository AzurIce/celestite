import { DropdownMenu as MenuPrimitive } from "@kobalte/core/dropdown-menu";
import type {
  DropdownMenuContentProps as PrimitiveContentProps,
  DropdownMenuItemProps as PrimitiveItemProps,
  DropdownMenuSeparatorProps as PrimitiveSeparatorProps,
} from "@kobalte/core/dropdown-menu";
import type { PolymorphicProps } from "@kobalte/core/polymorphic";
import { omit } from "solid-js";
import { cx } from "./utils";

export const DropdownMenu = MenuPrimitive;
export const DropdownMenuTrigger = MenuPrimitive.Trigger;
export type DropdownMenuContentProps = PolymorphicProps<
  "div",
  PrimitiveContentProps
>;
export type DropdownMenuItemProps = PolymorphicProps<"div", PrimitiveItemProps>;
export type DropdownMenuSeparatorProps = PolymorphicProps<
  "hr",
  PrimitiveSeparatorProps
>;

export function DropdownMenuContent(props: DropdownMenuContentProps) {
  const rest = omit(props, "class");
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Content {...rest} class={cx("ui-menu", props.class)} />
    </MenuPrimitive.Portal>
  );
}

export function DropdownMenuItem(props: DropdownMenuItemProps) {
  const rest = omit(props, "class");
  return (
    <MenuPrimitive.Item {...rest} class={cx("ui-menu-item", props.class)} />
  );
}

export function DropdownMenuSeparator(props: DropdownMenuSeparatorProps) {
  const rest = omit(props, "class");
  return (
    <MenuPrimitive.Separator
      {...rest}
      class={cx("ui-menu-separator", props.class)}
    />
  );
}
