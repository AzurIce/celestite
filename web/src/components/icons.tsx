import {
  Check as check,
  ChevronDown as chevronDown,
  FileText as fileText,
  Monitor as monitor,
  Moon as moon,
  Plus as plus,
  Sun as sun,
  X as x,
  type IconNode,
} from "lucide";
import { For, omit } from "solid-js";
import { dynamic, type ComponentProps } from "@solidjs/web";
import { cx } from "./ui/utils";

export type IconProps = ComponentProps<"svg"> & {
  size?: number | string;
  strokeWidth?: number | string;
};

/** 用 Lucide 的框架无关图标数据渲染 SVG，避开尚未支持 Solid 2 的 lucide-solid。 */
function createIcon(node: IconNode, name: string) {
  return function Icon(props: IconProps) {
    const rest = omit(props, "size", "strokeWidth", "class", "children");
    return (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width={props.size ?? 24}
        height={props.size ?? 24}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width={props.strokeWidth ?? 2}
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden={
          props["aria-label"] || props["aria-labelledby"] ? undefined : "true"
        }
        {...rest}
        class={cx("lucide", `lucide-${name}`, props.class)}
      >
        <For each={node}>
          {([tag, attributes]) => {
            const Shape = dynamic(() => tag);
            return <Shape {...attributes} />;
          }}
        </For>
        {props.children}
      </svg>
    );
  };
}

export const Check = createIcon(check, "check");
export const ChevronDown = createIcon(chevronDown, "chevron-down");
export const FileText = createIcon(fileText, "file-text");
export const Monitor = createIcon(monitor, "monitor");
export const Moon = createIcon(moon, "moon");
export const Plus = createIcon(plus, "plus");
export const Sun = createIcon(sun, "sun");
export const X = createIcon(x, "x");
