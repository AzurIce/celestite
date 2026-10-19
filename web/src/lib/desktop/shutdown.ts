import type { VaultManager } from "../vault/manager";
import { desktopInvoke } from "./platform";
import { flushSettings } from "../settings";

/** Prepare every view before the native runtime atomically releases its owners. */
export async function shutdownDesktopWorkspace(
  manager: VaultManager,
  shutdown: () => Promise<unknown> = () => desktopInvoke("desktop_shutdown"),
): Promise<boolean> {
  if (!(await manager.prepareClose())) return false;
  try {
    await flushSettings();
    await shutdown();
    manager.detach();
    return true;
  } catch (error) {
    manager.resumeAfterCloseFailure();
    throw error;
  }
}
