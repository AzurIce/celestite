import type { SettingsDocument } from "./document";

/**
 * 旧 localStorage 键到设置键的映射。首个版本启动时迁移一次，
 * 确认写入成功后删除旧键；写失败则保留旧键，下次启动再迁移。
 */
const LEGACY_KEYS: Record<string, string> = {
  "celestite.theme": "theme.mode",
  "celestite.workspace.sidebarWidth": "sidebar.width",
};

function readRaw(): Record<string, string> {
  try {
    const result: Record<string, string> = {};
    for (const key of Object.keys(LEGACY_KEYS)) {
      const value = localStorage.getItem(key);
      if (value !== null) result[key] = value;
    }
    return result;
  } catch {
    return {};
  }
}

export function hasLegacySettings() {
  return Object.keys(readRaw()).length > 0;
}

/** Legacy values are strings here; type coercion happens during schema parsing. */
export function readLegacyDocument(): SettingsDocument | null {
  const raw = readRaw();
  const document: SettingsDocument = {};
  const numericKeys = new Set(["sidebar.width"]);
  for (const [legacyKey, settingKey] of Object.entries(LEGACY_KEYS)) {
    const value = raw[legacyKey];
    if (value === undefined) continue;
    document[settingKey] = numericKeys.has(settingKey) ? Number(value) : value;
  }
  return Object.keys(document).length ? document : null;
}

export function clearLegacySettings() {
  try {
    for (const key of Object.keys(LEGACY_KEYS)) localStorage.removeItem(key);
  } catch {
    // Storage unavailable: the legacy keys simply stay unread.
  }
}
