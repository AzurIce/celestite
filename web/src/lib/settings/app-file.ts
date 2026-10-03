/** 全局设置的存储后端：OPFS `/celestite/settings.json`。 */

export interface SettingsFile {
  /** False for a session-only backend. Omitted means persistent. */
  readonly persistent?: boolean;
  /** 文件不存在返回 null；其他 IO 错误抛出。 */
  read(): Promise<string | null>;
  /** 写入整份文档；失败时保留旧内容，错误抛出。 */
  write(document: Record<string, unknown>): Promise<void>;
}

/** 存储不可用时的退路：只保留在当前会话内存里。 */
export function createMemoryFile(): SettingsFile {
  let stored: string | null = null;
  return {
    persistent: false,
    async read() {
      return stored;
    },
    async write(document) {
      stored = JSON.stringify(document, null, 2);
    },
  };
}

interface OpfsStorage {
  getDirectory(): Promise<FileSystemDirectoryHandle>;
}

/**
 * 与 `/vaults/<id>` 平级的 `/celestite/settings.json`。
 * 读改写由 Web Locks 串行化，写入沿用 createWritable + abort 保留旧内容。
 */
export async function openAppSettingsFile(
  storage: OpfsStorage | undefined = typeof navigator === "undefined"
    ? undefined
    : navigator.storage,
): Promise<SettingsFile> {
  return openAppDocument("settings.json", storage);
}

/** Separate app documents share the same OPFS app directory. */
export async function openAppDocument(
  fileName: "settings.json" | "connections.json",
  storage: OpfsStorage | undefined = typeof navigator === "undefined"
    ? undefined
    : navigator.storage,
): Promise<SettingsFile> {
  if (
    !storage ||
    typeof storage.getDirectory !== "function" ||
    typeof navigator === "undefined" ||
    typeof navigator.locks?.request !== "function" ||
    typeof FileSystemFileHandle === "undefined" ||
    typeof FileSystemFileHandle.prototype.createWritable !== "function"
  ) {
    return createMemoryFile();
  }
  const root = await storage.getDirectory();
  const directory = await root.getDirectoryHandle("celestite", {
    create: true,
  });
  return {
    async read() {
      let file: FileSystemFileHandle;
      try {
        file = await directory.getFileHandle(fileName);
      } catch (error) {
        if (error instanceof DOMException && error.name === "NotFoundError")
          return null;
        throw error;
      }
      return (await (await file.getFile()).text()).toString();
    },
    async write(document) {
      const bytes = new TextEncoder().encode(
        `${JSON.stringify(document, null, 2)}\n`,
      );
      await navigator.locks.request(`celestite.app.${fileName}`, async () => {
        const file = await directory.getFileHandle(fileName, { create: true });
        let writable: FileSystemWritableFileStream | undefined;
        try {
          writable = await file.createWritable();
          await writable.write(bytes);
          await writable.close();
        } catch (error) {
          try {
            await writable?.abort();
          } catch {
            /* 流可能已经关闭或出错。 */
          }
          throw error;
        }
      });
    },
  };
}
