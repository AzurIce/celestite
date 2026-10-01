import { Dialog as DialogPrimitive } from "@kobalte/core/dialog";
import type { DialogContentProps as PrimitiveContentProps } from "@kobalte/core/dialog";
import type { PolymorphicProps } from "@kobalte/core/polymorphic";
import { X } from "@/components/icons";
import { omit } from "solid-js";
import { IconButton } from "./button";
import { cx } from "./utils";

export const Dialog = DialogPrimitive;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.CloseButton;
export const DialogTitle = DialogPrimitive.Title;
export const DialogDescription = DialogPrimitive.Description;

export type DialogContentProps = PolymorphicProps<"div", PrimitiveContentProps>;

export function DialogContent(props: DialogContentProps) {
  const rest = omit(props, "class", "children");
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay class="ui-dialog-overlay" />
      <DialogPrimitive.Content {...rest} class={cx("ui-dialog", props.class)}>
        {props.children}
        <DialogClose
          as={IconButton}
          aria-label="关闭弹窗"
          class="ui-dialog-close"
        >
          <X size={16} aria-hidden="true" />
        </DialogClose>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}
