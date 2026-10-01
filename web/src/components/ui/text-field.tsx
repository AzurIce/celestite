import { TextField as FieldPrimitive } from "@kobalte/core/text-field";
import type {
  TextFieldRootProps as PrimitiveRootProps,
  TextFieldInputProps as PrimitiveInputProps,
  TextFieldLabelProps as PrimitiveLabelProps,
  TextFieldDescriptionProps as PrimitiveDescriptionProps,
  TextFieldErrorMessageProps as PrimitiveErrorMessageProps,
} from "@kobalte/core/text-field";
import type { PolymorphicProps } from "@kobalte/core/polymorphic";
import { splitProps } from "solid-js";
import { cx } from "./utils";

export type TextFieldProps = PolymorphicProps<"div", PrimitiveRootProps>;
export type TextFieldInputProps = PolymorphicProps<
  "input",
  PrimitiveInputProps
>;
export type TextFieldLabelProps = PolymorphicProps<
  "label",
  PrimitiveLabelProps
>;
export type TextFieldDescriptionProps = PolymorphicProps<
  "div",
  PrimitiveDescriptionProps
>;
export type TextFieldErrorMessageProps = PolymorphicProps<
  "div",
  PrimitiveErrorMessageProps
>;

export function TextFieldLabel(props: TextFieldLabelProps) {
  const [local, rest] = splitProps(props, ["class"]);
  return (
    <FieldPrimitive.Label {...rest} class={cx("ui-field-label", local.class)} />
  );
}

export function TextFieldDescription(props: TextFieldDescriptionProps) {
  const [local, rest] = splitProps(props, ["class"]);
  return (
    <FieldPrimitive.Description
      {...rest}
      class={cx("ui-field-description", local.class)}
    />
  );
}

export function TextFieldErrorMessage(props: TextFieldErrorMessageProps) {
  const [local, rest] = splitProps(props, ["class"]);
  return (
    <FieldPrimitive.ErrorMessage
      {...rest}
      class={cx("ui-field-error", local.class)}
    />
  );
}

export function TextField(props: TextFieldProps) {
  const [local, rest] = splitProps(props, ["class"]);
  return <FieldPrimitive {...rest} class={cx("ui-text-field", local.class)} />;
}

export function TextFieldInput(props: TextFieldInputProps) {
  const [local, rest] = splitProps(props, ["class"]);
  return <FieldPrimitive.Input {...rest} class={cx("ui-input", local.class)} />;
}
