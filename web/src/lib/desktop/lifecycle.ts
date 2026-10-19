import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import type { VaultManager } from "../vault/manager";
import { shutdownDesktopWorkspace } from "./shutdown";
import { clearComponentAssets } from "../preview/components";

/** A failed save or owner shutdown keeps the WebView and its input projection alive. */
export async function attachDesktopLifecycle(
  manager: VaultManager,
  report: (message: string) => void,
): Promise<() => void> {
  const window = getCurrentWindow();
  let closing = false;
  function close() {
    if (closing) return;
    closing = true;
    void (async () => {
      if (!(await shutdownDesktopWorkspace(manager))) return;
      await clearComponentAssets();
      await window.destroy();
    })()
      .catch((error) => {
        report(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        closing = false;
      });
  }
  const detachWindow = await window.onCloseRequested((event) => {
    event.preventDefault();
    close();
  });
  try {
    const detachQuit = await listen("celestite://close-requested", close);
    return () => {
      detachWindow();
      detachQuit();
    };
  } catch (error) {
    detachWindow();
    throw error;
  }
}
