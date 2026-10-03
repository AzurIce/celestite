import { createSignal } from "solid-js";
import { createMemoryFile, openAppSettingsFile } from "./app-file";
import { parseSettingsText, resolveSettings } from "./document";
import { clearLegacySettings, readLegacyDocument } from "./legacy";
import { SettingsStore, type SettingsSnapshot } from "./store";
import type { SettingKey, Settings } from "./schema";

const [current, setCurrent] = createSignal<SettingsSnapshot>({
  ...resolveSettings(
    parseSettingsText(null, "app"),
    parseSettingsText(null, "project"),
  ),
  storage: "file",
});

let store: SettingsStore | null = null;

/**
 * 启动时调用一次：读取全局设置、迁移旧 localStorage 键。
 * 不抛出：存储不可用时退回内存文档，应用仍以默认值启动。
 */
export async function initSettings(): Promise<SettingsStore> {
  if (store) return store;
  let file: Awaited<ReturnType<typeof openAppSettingsFile>>;
  try {
    file = await openAppSettingsFile();
  } catch {
    file = createMemoryFile();
  }
  const instance = new SettingsStore({
    file,
    migrateLegacy: readLegacyDocument,
    clearLegacy: clearLegacySettings,
  });
  // 先订阅再加载，加载过程产生的快照也会推到信号里。
  instance.subscribe(setCurrent);
  await instance.load();
  store = instance;
  return instance;
}

/** 同步读取当前生效设置；在 JSX 中读取是响应式的。 */
export function settings(): SettingsSnapshot {
  return current();
}

/** 设置变化时执行副作用（应用主题、同步第三方状态等）。 */
export function subscribeSettings(
  listener: (snapshot: SettingsSnapshot) => void,
) {
  const instance = store;
  if (!instance) return () => {};
  return instance.subscribe(listener);
}

/** vault 打开后调用：提供项目级 `.celestite/settings.json` 的读取器并立即载入。 */
export function attachProjectSettings(read: () => Promise<string | null>) {
  const instance = store;
  if (!instance) return;
  instance.setProjectReader(read);
  return instance.reloadProject();
}

/** vault 关闭后调用：丢弃项目级覆盖，保留全局设置。 */
export function clearProjectSettings() {
  store?.clearProject();
}

export function setSetting<K extends SettingKey>(
  key: K,
  value: Settings[K],
  options?: { persist?: boolean },
) {
  return store?.set(key, value, options);
}

export { SettingsStore };
export type { SettingsSnapshot };
