import { settings, setSetting, subscribeSettings } from "./settings";
import type { ThemeModeSetting } from "./settings/schema";

export type ThemeMode = ThemeModeSetting;

/** 当前主题模式取自设置层（默认值 < 全局文件 < 项目文件）。 */
export function theme(): ThemeMode {
  return settings().values["theme.mode"];
}

/** 写入设置层；保存失败时内存态保留，界面继续响应用户选择。 */
export function setTheme(mode: ThemeMode): Promise<void> | undefined {
  return setSetting("theme.mode", mode);
}

function applyTheme(mode: ThemeMode) {
  document.documentElement.dataset.theme =
    mode === "system"
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : mode;
}

/**
 * 设置就绪后应用一次主题，并在设置变化或系统配色变化时重新应用。
 * 返回取消订阅函数，供热更新 dispose 使用。
 */
export function initializeTheme() {
  // 使用通知携带的生效模式，避免同步读到尚未提交的 Solid signal。
  let mode = theme();
  applyTheme(mode);
  const unsubscribe = subscribeSettings((snapshot) => {
    mode = snapshot.values["theme.mode"];
    applyTheme(mode);
  });
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const onChange = () => {
    if (mode === "system") applyTheme(mode);
  };
  media.addEventListener("change", onChange);
  return () => {
    unsubscribe();
    media.removeEventListener("change", onChange);
  };
}
