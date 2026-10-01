import type { JSX } from "@solidjs/web";

/**
 * 组合 Solid 2 的 class 值，支持字符串、条件对象和嵌套数组。
 * 渲染器负责展开数组、忽略空值和 false，并保持条件类名的响应性。
 *
 * @param classes 要组合的类名。
 * @returns 可直接传给 class 属性的数组；不会处理样式冲突。
 * @example cx("ui-button", props.class, disabled && "opacity-50")
 */
export function cx(...classes: JSX.ClassValue[]): JSX.ClassValue[] {
  return classes;
}
