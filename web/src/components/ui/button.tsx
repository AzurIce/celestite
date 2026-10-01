import { Button as ButtonPrimitive } from "@kobalte/core/button";
import { splitProps, type ComponentProps } from "solid-js";
import { cx } from "./utils";

export type ButtonProps = ComponentProps<"button"> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md";
};

export function Button(props: ButtonProps) {
  const [local, rest] = splitProps(props, ["class", "variant", "size"]);
  return (
    <ButtonPrimitive
      type="button"
      {...rest}
      class={cx("ui-button", local.class)}
      data-variant={local.variant ?? "secondary"}
      data-size={local.size ?? "md"}
    />
  );
}

export type IconButtonProps = Omit<ButtonProps, "aria-label"> & {
  "aria-label": string;
};

export function IconButton(props: IconButtonProps) {
  const [local, rest] = splitProps(props, ["class"]);
  return (
    <Button
      variant="ghost"
      {...rest}
      class={cx("ui-icon-button", local.class)}
    />
  );
}
