import { vaultPath } from "../vault";
import type { VaultBackend } from "../vault";

/** 项目级设置文件：打开的 vault 根目录下，应用只读。 */
export const PROJECT_SETTINGS_PATH = ".celestite/settings.json";

/**
 * 读取项目级设置文本；文件不存在或读取失败都返回 null，
 * 上层据此判断“没有项目级覆盖”。应用不写这个文件。
 */
export async function readProjectSettings(
  backend: VaultBackend,
): Promise<string | null> {
  try {
    const path = vaultPath(PROJECT_SETTINGS_PATH);
    if ((await backend.stat(path)) === null) return null;
    return new TextDecoder().decode(await backend.readFile(path));
  } catch {
    return null;
  }
}
