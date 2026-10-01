import { createSignal } from "solid-js";

export type ThemeMode = "system" | "light" | "dark";
const storageKey = "celestite.theme";

function readTheme(): ThemeMode {
  try {
    const value = localStorage.getItem(storageKey);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
}

const [theme, updateTheme] = createSignal<ThemeMode>(readTheme());
export { theme };

function applyTheme() {
  const mode = theme();
  document.documentElement.dataset.theme =
    mode === "system"
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : mode;
}

export function setTheme(mode: ThemeMode) {
  updateTheme(mode);
  applyTheme();
  try {
    // TODO: 这个在 tauri 下肯定是要保存到编辑器的持久化设置里而不是浏览器 localStorage 里的，结合后面的后端抽象应该要做一些重构与设计
    localStorage.setItem(storageKey, mode);
  } catch {
    // Theme switching still works when storage is unavailable.
  }
}

export function initializeTheme() {
  applyTheme();
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const onChange = () => {
    if (theme() === "system") applyTheme();
  };
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}
