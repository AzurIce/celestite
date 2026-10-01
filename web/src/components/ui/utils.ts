/**
 * 将类名用空格拼接，忽略空字符串、undefined 和 false，方便组合可选或条件类名。
 *
 * @param classes 要组合的类名。
 * @returns 拼接后的 class 字符串；不会去重或处理样式冲突。
 * @example cx("ui-button", props.class, disabled && "opacity-50")
 */
export function cx(...classes: (string | undefined | false)[]) {
  return classes.filter(Boolean).join(" ");
}
