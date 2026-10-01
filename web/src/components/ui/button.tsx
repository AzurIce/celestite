import {
  Button as ButtonPrimitive,
  type ButtonRootProps,
} from "@kobalte/core/button";
import type { PolymorphicProps } from "@kobalte/core/polymorphic";
import { omit } from "solid-js";
import { cx } from "./utils";

export type ButtonProps = Omit<
  PolymorphicProps<"button", ButtonRootProps<"button">>,
  "as" | "type"
> & {
  type?: "button" | "submit" | "reset";
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md";
};

export function Button(props: ButtonProps) {
  const rest = omit(props, "class", "variant", "size");
  return (
    <ButtonPrimitive
      type="button"
      {...rest}
      class={cx("ui-button", props.class)}
      data-variant={props.variant ?? "secondary"}
      data-size={props.size ?? "md"}
    />
  );
}

export type IconButtonProps = Omit<ButtonProps, "aria-label"> & {
  "aria-label": string;
};

export function IconButton(props: IconButtonProps) {
  const rest = omit(props, "class");
  return (
    <Button
      variant="ghost"
      {...rest}
      class={cx("ui-icon-button", props.class)}
    />
  );
}
