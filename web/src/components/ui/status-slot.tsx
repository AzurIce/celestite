import { Show } from "solid-js";
import { Portal, type JSX } from "@solidjs/web";

/** Keep a panel's status reactive while displaying it in the workspace footer. */
export function StatusSlot(props: {
  mount?: Element;
  class: string;
  children: JSX.Element;
}) {
  const content = () => <div class={props.class}>{props.children}</div>;
  return (
    <Show when={props.mount} keyed fallback={content()}>
      {(mount) => <Portal mount={mount}>{content()}</Portal>}
    </Show>
  );
}
