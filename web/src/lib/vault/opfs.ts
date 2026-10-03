import { isDomError, opfsError, VaultError, VaultRenameError } from "./errors";
import { childPath, ROOT_PATH, splitPath, vaultPath } from "./path";
import type { VaultPath } from "./path";
import type {
  ChangeHint,
  Entry,
  EntryStat,
  VaultBackend,
  WriteFileOptions,
} from "./types";

type OpfsEntry = FileSystemFileHandle | FileSystemDirectoryHandle;

function isFileHandle(
  handle: FileSystemHandle,
): handle is FileSystemFileHandle {
  return handle.kind === "file";
}

function isDirectoryHandle(
  handle: FileSystemHandle,
): handle is FileSystemDirectoryHandle {
  return handle.kind === "directory";
}

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
    return new OpfsVaultBackend(
      root,
      navigator.locks,
      `celestite.vault.opfs:${id}`,
    );
  } catch (error) {
    throw opfsError(error, "openVault", id);
  }
}

/** 不依赖实验性移动或监听 API；watch 接受订阅但不发出事件。 */
class OpfsVaultBackend implements VaultBackend {
  private closed = false;
  private closing?: Promise<void>;
  private readonly pending = new Set<Promise<unknown>>();

  constructor(
    private readonly root: FileSystemDirectoryHandle,
    private readonly locks: LockManager,
    private readonly lockName: string,
  ) {}

  async *readDir(path: VaultPath): AsyncIterable<Entry> {
    const directory = await this.run("readDir", path, () =>
      this.directory(vaultPath(path)),
    );
    const iterator = directory.entries();
    while (true) {
      // 不跨 yield 持有锁或操作计数，close 不会被暂停的迭代器阻塞。
      const result = await this.run("readDir", path, () => iterator.next());
      if (result.done) return;
      const [name, handle] = result.value;
      yield { path: childPath(path, name), kind: handle.kind };
    }
  }

  stat(path: VaultPath): Promise<EntryStat | null> {
    return this.run("stat", path, async () => {
      vaultPath(path);
      try {
        const entry = await this.entry(path);
        if (entry.kind === "directory") return { path, kind: "directory" };
        const file = await entry.getFile();
        return {
          path,
          kind: "file",
          size: file.size,
          modifiedAt: file.lastModified,
        };
      } catch (error) {
        if (isDomError(error, "NotFoundError")) return null;
        throw error;
      }
    });
  }

  readFile(path: VaultPath): Promise<Uint8Array> {
    return this.run("readFile", path, async () => {
      vaultPath(path);
      const entry = await this.entry(path);
      if (entry.kind !== "file") {
        throw new VaultError(
          "NotFile",
          "Cannot read a directory as a file",
          path,
        );
      }
      return new Uint8Array(await (await entry.getFile()).arrayBuffer());
    });
  }

  writeFile(
    path: VaultPath,
    data: Uint8Array,
    options: WriteFileOptions,
  ): Promise<void> {
    return this.run("writeFile", path, async () => {
      if (options.expectedRevision !== undefined) {
        throw new VaultError(
          "Unsupported",
          "OPFS does not support conditional writes",
          path,
        );
      }
      const { parent, name } = splitPath(path);
      // 在第一次 await 前复制，排队保存不受调用者之后修改 buffer 的影响。
      const bytes = new Uint8Array(data);
      const mode = options.mode;
      if (mode !== "create" && mode !== "replace") {
        throw new VaultError("Unsupported", "Unknown file write mode", path);
      }
      await this.mutate(async () => {
        const directory = await this.directory(parent);
        const existing = await this.findEntry(directory, name);
        if (mode === "create" && existing) {
          throw new VaultError("AlreadyExists", "Entry already exists", path);
        }
        if (mode === "replace" && !existing) {
          throw new VaultError("NotFound", "File does not exist", path);
        }
        if (existing?.kind === "directory") {
          throw new VaultError(
            "NotFile",
            "Cannot write a directory as a file",
            path,
          );
        }

        const file =
          existing ?? (await directory.getFileHandle(name, { create: true }));
        let writable: FileSystemWritableFileStream | undefined;
        try {
          writable = await file.createWritable();
          await writable.write(bytes);
          await writable.close();
        } catch (error) {
          // 已有文件通过 abort 保留旧内容；新建失败时清理空条目。
          try {
            await writable?.abort();
          } catch {
            /* 流可能已经关闭或出错。 */
          }
          if (!existing) {
            try {
              await directory.removeEntry(name);
            } catch (cleanupError) {
              throw new VaultError(
                "IO",
                "Write failed and the new entry could not be removed",
                path,
                {
                  writeError: error,
                  cleanupError,
                },
              );
            }
          }
          throw error;
        }
      });
    });
  }

  mkdir(path: VaultPath, options?: { recursive?: boolean }): Promise<void> {
    return this.run("mkdir", path, async () => {
      vaultPath(path);
      const recursive = options?.recursive ?? false;
      await this.mutate(async () => {
        if (recursive) {
          await this.directory(path, true);
          return;
        }
        if (path === ROOT_PATH) {
          throw new VaultError(
            "AlreadyExists",
            "Vault root already exists",
            path,
          );
        }
        const { parent, name } = splitPath(path);
        const directory = await this.directory(parent);
        if (await this.findEntry(directory, name)) {
          throw new VaultError("AlreadyExists", "Entry already exists", path);
        }
        await directory.getDirectoryHandle(name, { create: true });
      });
    });
  }

  remove(path: VaultPath, options?: { recursive?: boolean }): Promise<void> {
    return this.run("remove", path, async () => {
      const { parent, name } = splitPath(path);
      const recursive = options?.recursive ?? false;
      await this.mutate(async () => {
        const directory = await this.directory(parent);
        await directory.removeEntry(name, { recursive });
      });
    });
  }

  rename(from: VaultPath, to: VaultPath): Promise<void> {
    return this.run("rename", from, async () => {
      // 即便 from === to，也先拒绝根路径和未经校验的路径。
      const sourcePath = splitPath(from);
      const targetPath = splitPath(to);
      await this.mutate(async () => {
        const sourceParent = await this.directory(sourcePath.parent);
        const source = await this.findEntry(sourceParent, sourcePath.name);
        if (!source)
          throw new VaultError("NotFound", "Source entry does not exist", from);
        if (from === to) return;
        if (source.kind === "directory" && to.startsWith(`${from}/`)) {
          throw new VaultError(
            "InvalidPath",
            "Cannot move a directory into itself",
            to,
          );
        }
        const targetParent = await this.directory(targetPath.parent);
        if (await this.findEntry(targetParent, targetPath.name)) {
          throw new VaultError(
            "AlreadyExists",
            "Target entry already exists",
            to,
          );
        }

        let target: OpfsEntry | undefined;
        try {
          target =
            source.kind === "file"
              ? await targetParent.getFileHandle(targetPath.name, {
                  create: true,
                })
              : await targetParent.getDirectoryHandle(targetPath.name, {
                  create: true,
                });
          await this.copyEntry(source, target, to);
        } catch (error) {
          let cleanupError: VaultError | undefined;
          if (target) {
            try {
              await targetParent.removeEntry(targetPath.name, {
                recursive: true,
              });
            } catch (cleanup) {
              cleanupError = opfsError(cleanup, "remove", to);
            }
          }
          throw new VaultRenameError(
            opfsError(error, "copy", to),
            from,
            to,
            "copy",
            cleanupError,
          );
        }

        // 复制全部成功后才开始删除。删除可能部分完成，此后绝不能回滚目标。
        try {
          await sourceParent.removeEntry(sourcePath.name, {
            recursive: source.kind === "directory",
          });
        } catch (error) {
          throw new VaultRenameError(
            opfsError(error, "remove", from),
            from,
            to,
            "remove-source",
          );
        }
      });
    });
  }

  watch(_listener: (hint: ChangeHint) => void): Promise<() => void> {
    return this.run("watch", ROOT_PATH, async () => () => {});
  }

  close(): Promise<void> {
    if (!this.closing) {
      this.closed = true;
      this.closing = Promise.allSettled([...this.pending]).then(
        () => undefined,
      );
    }
    return this.closing;
  }

  private run<T>(
    operation: string,
    path: VaultPath,
    task: () => Promise<T>,
  ): Promise<T> {
    if (this.closed) {
      return Promise.reject(
        new VaultError("Closed", "Vault backend is closed", path),
      );
    }
    const promise = (async () => {
      try {
        return await task();
      } catch (error) {
        throw opfsError(error, operation, path);
      }
    })();
    this.pending.add(promise);
    const finished = () => this.pending.delete(promise);
    void promise.then(finished, finished);
    return promise;
  }

  private async mutate<T>(task: () => Promise<T>): Promise<T> {
    // 所有会话和标签页使用相同锁名，保护检查后创建等复合操作。
    return await this.locks.request(this.lockName, task);
  }

  /** 只在已持有 Vault 写锁时调用；顺序复制，失败后没有后台复制任务残留。 */
  private async copyEntry(
    source: FileSystemHandle,
    target: OpfsEntry,
    path: VaultPath,
  ): Promise<void> {
    if (isFileHandle(source) && target.kind === "file") {
      const file = await source.getFile();
      const reader = file.stream().getReader();
      let writable: FileSystemWritableFileStream | undefined;
      try {
        writable = await target.createWritable();
        let copied = 0;
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          await writable.write(chunk.value);
          copied += chunk.value.byteLength;
        }
        if (copied !== file.size) {
          throw new VaultError(
            "IO",
            "File stream length changed during copy",
            path,
          );
        }
        await writable.close();
      } catch (error) {
        let cancelError: unknown;
        let abortError: unknown;
        try {
          await reader.cancel();
        } catch (cancel) {
          cancelError = cancel;
        }
        try {
          await writable?.abort();
        } catch (abort) {
          abortError = abort;
        }
        if (cancelError !== undefined || abortError !== undefined) {
          const copyError = opfsError(error, "copy", path);
          throw new VaultError(
            copyError.code,
            "Copy failed and stream cleanup failed",
            path,
            {
              copyError,
              cancelError,
              abortError,
            },
          );
        }
        throw error;
      } finally {
        reader.releaseLock();
      }
      return;
    }
    if (isDirectoryHandle(source) && target.kind === "directory") {
      for await (const [name, entry] of source.entries()) {
        const destination = childPath(path, name);
        const child =
          entry.kind === "file"
            ? await target.getFileHandle(name, { create: true })
            : await target.getDirectoryHandle(name, { create: true });
        await this.copyEntry(entry, child, destination);
      }
      return;
    }
    throw new VaultError(
      "IO",
      "Source and target kinds differ during copy",
      path,
    );
  }

  private async directory(
    path: VaultPath,
    create = false,
  ): Promise<FileSystemDirectoryHandle> {
    let directory = this.root;
    let current = ROOT_PATH;
    for (const name of path === ROOT_PATH ? [] : path.split("/")) {
      current = childPath(current, name);
      try {
        directory = await directory.getDirectoryHandle(name, { create });
      } catch (error) {
        if (isDomError(error, "TypeMismatchError")) {
          throw new VaultError(
            "NotDirectory",
            "Path component is not a directory",
            current,
            error,
          );
        }
        throw error;
      }
    }
    return directory;
  }

  private async entry(path: VaultPath): Promise<OpfsEntry> {
    if (path === ROOT_PATH) return this.root;
    const { parent, name } = splitPath(path);
    const directory = await this.directory(parent);
    const entry = await this.findEntry(directory, name);
    if (!entry) throw new DOMException("Entry does not exist", "NotFoundError");
    return entry;
  }

  private async findEntry(
    directory: FileSystemDirectoryHandle,
    name: string,
  ): Promise<OpfsEntry | null> {
    try {
      return await directory.getFileHandle(name);
    } catch (error) {
      if (isDomError(error, "NotFoundError")) return null;
      if (isDomError(error, "TypeMismatchError"))
        return directory.getDirectoryHandle(name);
      throw error;
    }
  }
}
