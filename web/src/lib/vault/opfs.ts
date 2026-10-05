import { DirectoryHandleVaultBackend } from "./directory-handle";
import { fileSystemError, VaultError } from "./errors";
import { vaultPath } from "./path";
import type { VaultBackend } from "./types";

/**
 * 打开 OPFS /vaults/<id>；首次创建，此后恢复已有文件。
 * 默认 Vault 的身份固定，不会因重开页面而生成新目录。
 * 需要 OPFS、createWritable 和 Web Locks，不降级成易丢数据的内存存储。
 */
export async function openOpfsVault(id = "default"): Promise<VaultBackend> {
  vaultPath(id);
  if (id === "" || id.includes("/")) {
    throw new VaultError(
      "InvalidPath",
      "Vault id must be a single directory name",
      id,
    );
  }
  if (
    typeof navigator === "undefined" ||
    typeof navigator.storage?.getDirectory !== "function" ||
    typeof navigator.locks?.request !== "function" ||
    typeof FileSystemFileHandle === "undefined" ||
    typeof FileSystemFileHandle.prototype.createWritable !== "function"
  ) {
    throw new VaultError(
      "Unsupported",
      "OPFS writable files and Web Locks are required",
    );
  }

  try {
    const opfs = await navigator.storage.getDirectory();
    const vaults = await opfs.getDirectoryHandle("vaults", { create: true });
    const root = await vaults.getDirectoryHandle(id, { create: true });
    return new DirectoryHandleVaultBackend(
      root,
      navigator.locks,
      `celestite.vault.opfs:${id}`,
    );
  } catch (error) {
    throw fileSystemError(error, "openVault", id);
  }
}
