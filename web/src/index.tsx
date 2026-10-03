/* @refresh reload */
import { render } from "@solidjs/web";
import "./styles/theme.css";
import "virtual:uno.css";
import "./styles/ui.css";
import App from "./App";
import { initSettings } from "./lib/settings";
import { initializeTheme } from "@/lib/theme";

// 设置是主题与各偏好的唯一来源；先读全局设置（含旧 localStorage 迁移）
// 再渲染，避免第一帧画错主题。initSettings 内部不抛，失败时以默认值启动。
void initSettings().then(() => {
  const cleanupTheme = initializeTheme();
  import.meta.hot?.dispose(cleanupTheme);
  render(() => <App />, document.getElementById("root") as HTMLElement);
});
