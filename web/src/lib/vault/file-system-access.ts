import { DirectoryHandleVaultBackend } from "./directory-handle";
import { fileSystemError, VaultError } from "./errors";

export type LocalDirectoryHandle = FileSystemDirectoryHandle & {
  queryPermission(options: { mode: "readwrite" }): Promise<PermissionState>;
  requestPermission(options: { mode: "readwrite" }): Promise<PermissionState>;
};
type DirectoryPickerWindow = Window & {
  showDirectoryPicker?: (options: {
    id: string;
    mode: "readwrite";
  }) => Promise<LocalDirectoryHandle>;
};

export function supportsLocalDirectories(): boolean {
  return (
    typeof window !== "undefined" &&
    window.isSecureContext &&
    typeof (window as DirectoryPickerWindow).showDirectoryPicker === "function"
  );
}

/** Call directly from a user gesture, before other asynchronous work. */
export async function pickLocalDirectory(): Promise<LocalDirectoryHandle | null> {
  if (!supportsLocalDirectories())
    throw new VaultError("Unsupported", "此浏览器不支持打开本机目录。");
  try {
    return await (window as DirectoryPickerWindow).showDirectoryPicker!({
      id: "celestite-vault",
      mode: "readwrite",
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError")
      return null;
    throw fileSystemError(error, "选择本机目录");
  }
}

/** The handle is already cached: requesting permission must retain activation. */
export async function authorizeDirectory(
  handle: LocalDirectoryHandle,
): Promise<void> {
  try {
    if ((await handle.requestPermission({ mode: "readwrite" })) !== "granted")
      throw new VaultError(
        "PermissionDenied",
        "需要目录的读写权限，请再次打开并授权。",
      );
  } catch (error) {
    throw fileSystemError(error, "授权本机目录");
  }
}

/** Workers only query grants; permission prompts belong to the main thread. */
export async function openDirectoryVault(
  handle: LocalDirectoryHandle,
  id: string,
) {
  if (typeof navigator.locks?.request !== "function")
    throw new VaultError("Unsupported", "本机目录需要 Web Locks 支持。");
  if ((await handle.queryPermission({ mode: "readwrite" })) !== "granted")
    throw new VaultError(
      "PermissionDenied",
      "目录权限已失效，请重新打开并授权。",
    );
  return new DirectoryHandleVaultBackend(
    handle,
    navigator.locks,
    `celestite.vault.directory:${id}`,
    { externalWriters: true },
  );
}
