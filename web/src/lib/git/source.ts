import type { GitStatusSnapshot } from "../editor/generated/celestite_core";
import { desktopInvoke, type DesktopInvoke } from "../desktop/platform";
import type { HttpVaultBackend } from "../vault/http";
import type { GitStatusSource } from "./status";

/** Native local sessions scan their own filesystem through the Tauri core. */
export function nativeGitStatus(
  handle: string,
  invoke: DesktopInvoke = desktopInvoke,
): GitStatusSource {
  return {
    status: () =>
      invoke<GitStatusSnapshot | null>("desktop_git_status", { handle }),
  };
}

/** Remote sessions ask the host that owns the repository. */
export function remoteGitStatus(http: HttpVaultBackend): GitStatusSource {
  return {
    status: () => http.documentRequest<GitStatusSnapshot | null>("/git/status"),
  };
}
