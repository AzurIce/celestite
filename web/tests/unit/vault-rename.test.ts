import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import {
  openOpfsVault,
  ROOT_PATH,
  vaultPath,
  VaultError,
  VaultRenameError,
} from "../../src/lib/vault";

// 模拟 OPFS 的暂存写入与同源锁，允许在实际后端的各个 IO 边界注入错误。
// 这些测试验证算法与错误传播；浏览器实现的行为另由 vault.spec.ts 验证。
class MemoryOpfs {
  readonly root = new MemoryDirectory(this, "");
  readonly locks = new MemoryLocks();
  readonly removed: string[] = [];
  readonly aborted: string[] = [];
  bulkReads = 0;
  rejectBulkReads = false;
  onRead?: (path: string) => void;
  onStreamPull?: (path: string, offset: number) => void;
  onWrite?: (path: string) => void | Promise<void>;
  onClose?: (path: string) => void;
  onAbort?: (path: string) => void;
  onRemove?: (path: string) => void;
}

class MemoryFile {
  readonly kind = "file";
  bytes = new Uint8Array();
  constructor(
    readonly fs: MemoryOpfs,
    readonly path: string,
  ) {}

  async getFile(): Promise<File> {
    this.fs.onRead?.(this.path);
    const file = new File([this.bytes], this.path);
    const arrayBuffer = file.arrayBuffer.bind(file);
    file.arrayBuffer = async () => {
      this.fs.bulkReads++;
      if (this.fs.rejectBulkReads)
        throw new Error("Whole-file reads are forbidden during rename");
      return arrayBuffer();
    };
    if (this.fs.onStreamPull) {
      const bytes = this.bytes.slice();
      file.stream = () => {
        let offset = 0;
        return new ReadableStream<Uint8Array<ArrayBuffer>>({
          pull: (controller) => {
            this.fs.onStreamPull?.(this.path, offset);
            if (offset === bytes.byteLength) {
              controller.close();
              return;
            }
            const chunk = bytes.slice(offset, offset + 2);
            offset += chunk.byteLength;
            controller.enqueue(chunk);
          },
        });
      };
    }
    return file;
  }

  async createWritable() {
    const chunks: Uint8Array[] = [];
    return {
      write: async (data: Uint8Array) => {
        chunks.push(data.slice());
        await this.fs.onWrite?.(this.path);
      },
      close: async () => {
        this.fs.onClose?.(this.path);
        const bytes = new Uint8Array(
          chunks.reduce((size, chunk) => size + chunk.byteLength, 0),
        );
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        this.bytes = bytes;
      },
      abort: async () => {
        this.fs.aborted.push(this.path);
        this.fs.onAbort?.(this.path);
        chunks.length = 0;
      },
    };
  }
}

class MemoryDirectory {
  readonly kind = "directory";
  readonly children = new Map<string, MemoryDirectory | MemoryFile>();
  constructor(
    readonly fs: MemoryOpfs,
    readonly path: string,
  ) {}
  private childPath(name: string) {
    return this.path ? `${this.path}/${name}` : name;
  }

  async getDirectoryHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<MemoryDirectory> {
    const child = this.children.get(name);
    if (child instanceof MemoryDirectory) return child;
    if (child) throw new DOMException("Not a directory", "TypeMismatchError");
    if (!options?.create)
      throw new DOMException("Missing directory", "NotFoundError");
    const directory = new MemoryDirectory(this.fs, this.childPath(name));
    this.children.set(name, directory);
    return directory;
  }

  async getFileHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<MemoryFile> {
    const child = this.children.get(name);
    if (child instanceof MemoryFile) return child;
    if (child) throw new DOMException("Not a file", "TypeMismatchError");
    if (!options?.create)
      throw new DOMException("Missing file", "NotFoundError");
    const file = new MemoryFile(this.fs, this.childPath(name));
    this.children.set(name, file);
    return file;
  }

  async removeEntry(name: string, options?: { recursive?: boolean }) {
    const path = this.childPath(name);
    this.fs.removed.push(path);
    this.fs.onRemove?.(path);
    const child = this.children.get(name);
    if (!child) throw new DOMException("Missing entry", "NotFoundError");
    if (
      child instanceof MemoryDirectory &&
      child.children.size &&
      !options?.recursive
    ) {
      throw new DOMException(
        "Directory is not empty",
        "InvalidModificationError",
      );
    }
    this.children.delete(name);
  }

  async *entries() {
    yield* this.children.entries();
  }
}

class MemoryLocks {
  private readonly queues = new Map<string, Promise<unknown>>();
  request<T>(name: string, task: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(name) ?? Promise.resolve();
    const next = previous.then(task);
    this.queues.set(
      name,
      next.catch(() => {}),
    );
    return next;
  }
}

const originalNavigator = Object.getOwnPropertyDescriptor(
  globalThis,
  "navigator",
);
const originalFileHandle = Object.getOwnPropertyDescriptor(
  globalThis,
  "FileSystemFileHandle",
);
afterEach(() => {
  for (const [name, descriptor] of [
    ["navigator", originalNavigator],
    ["FileSystemFileHandle", originalFileHandle],
  ] as const) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

async function setup() {
  const fs = new MemoryOpfs();
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { storage: { getDirectory: async () => fs.root }, locks: fs.locks },
  });
  Object.defineProperty(globalThis, "FileSystemFileHandle", {
    configurable: true,
    value: MemoryFile,
  });
  const backend = await openOpfsVault();
  const write = (path: string, bytes = [1, 2, 3]) =>
    backend.writeFile(vaultPath(path), new Uint8Array(bytes), {
      mode: "create",
    });
  return { fs, backend, write };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function renameError(
  operation: Promise<void>,
): Promise<VaultRenameError> {
  try {
    await operation;
  } catch (error) {
    assert.ok(error instanceof VaultRenameError);
    return error;
  }
  throw new Error("Expected rename to fail");
}

test("rename streams complete trees, preserves empty directories and emits no watch events", async () => {
  const { fs, backend, write } = await setup();
  await backend.mkdir(vaultPath("notes/nested/empty"), { recursive: true });
  await write("notes/nested/中文.md", [0, 255, 128]);
  await write("notes/empty.md", []);
  const attachment = new Uint8Array(2 * 1024 * 1024 + 7).fill(137);
  await backend.writeFile(vaultPath("notes/attachment"), attachment, {
    mode: "create",
  });
  let events = 0;
  await backend.watch(() => {
    events++;
  });
  fs.rejectBulkReads = true;
  await backend.rename(vaultPath("notes"), vaultPath("notebook"));
  await backend.rename(vaultPath("notebook/empty.md"), vaultPath("empty.md"));
  fs.rejectBulkReads = false;
  assert.equal(fs.bulkReads, 0);
  assert.equal(await backend.stat(vaultPath("notes")), null);
  assert.deepEqual(
    Array.from(await backend.readFile(vaultPath("notebook/nested/中文.md"))),
    [0, 255, 128],
  );
  assert.deepEqual(
    await backend.readFile(vaultPath("notebook/attachment")),
    attachment,
  );
  assert.equal(
    (await backend.stat(vaultPath("notebook/nested/empty")))?.kind,
    "directory",
  );
  assert.equal((await backend.stat(vaultPath("empty.md")))?.size, 0);
  assert.equal(events, 0);
  await backend.close();
  const reopened = await openOpfsVault();
  assert.equal(
    (await reopened.stat(vaultPath("notebook/attachment")))?.size,
    attachment.byteLength,
  );
  await reopened.close();
});

test("rename preconditions and same-path no-ops preserve both existing trees", async () => {
  const { fs, backend, write } = await setup();
  await backend.mkdir(vaultPath("a/sub"), { recursive: true });
  await backend.mkdir(vaultPath("occupied"));
  await write("a/source");
  await write("occupied/file", [9]);
  await write("target", [8]);
  const cases = [
    ["a", "a/sub/new", "InvalidPath"],
    ["", "new", "InvalidPath"],
    ["a", "", "InvalidPath"],
    ["a/source", "target", "AlreadyExists"],
    ["a", "occupied", "AlreadyExists"],
    ["a/source", "occupied", "AlreadyExists"],
    ["a", "target", "AlreadyExists"],
    ["a/source", "missing/new", "NotFound"],
    ["a/source", "target/new", "NotDirectory"],
    ["missing", "missing", "NotFound"],
    ["../a", "new", "InvalidPath"],
    ["a", "/new", "InvalidPath"],
  ] as const;
  for (const [from, to, code] of cases) {
    await assert.rejects(
      backend.rename(
        from as ReturnType<typeof vaultPath>,
        to as ReturnType<typeof vaultPath>,
      ),
      (error: unknown) => error instanceof VaultError && error.code === code,
    );
  }
  await backend.rename(vaultPath("a/source"), vaultPath("a/source"));
  await backend.rename(vaultPath("a"), vaultPath("a"));
  assert.equal(fs.removed.length, 0);
  assert.deepEqual(
    Array.from(await backend.readFile(vaultPath("target"))),
    [8],
  );
  assert.deepEqual(
    Array.from(await backend.readFile(vaultPath("occupied/file"))),
    [9],
  );
  // 名称共享前缀不是祖先关系。
  await backend.rename(vaultPath("a"), vaultPath("ab"));
  assert.deepEqual(
    Array.from(await backend.readFile(vaultPath("ab/source"))),
    [1, 2, 3],
  );
  await backend.close();
});

test("a later child write failure aborts copying and preserves the entire source tree", async () => {
  const { fs, backend, write } = await setup();
  await backend.mkdir(vaultPath("source/empty"), { recursive: true });
  await write("source/a");
  await write("source/b", [4]);
  fs.onWrite = (path) => {
    if (path.endsWith("/target/b"))
      throw new DOMException("Quota exhausted", "QuotaExceededError");
  };
  const error = await renameError(
    backend.rename(vaultPath("source"), vaultPath("target")),
  );
  assert.equal(error.code, "QuotaExceeded");
  assert.equal(error.phase, "copy");
  assert.equal(error.targetComplete, false);
  assert.equal(error.cleanupError, undefined);
  assert.equal(error.from, "source");
  assert.equal(error.to, "target");
  assert.equal(await backend.stat(vaultPath("target")), null);
  assert.deepEqual(
    Array.from(await backend.readFile(vaultPath("source/a"))),
    [1, 2, 3],
  );
  assert.deepEqual(
    Array.from(await backend.readFile(vaultPath("source/b"))),
    [4],
  );
  assert.equal(
    (await backend.stat(vaultPath("source/empty")))?.kind,
    "directory",
  );
  assert.deepEqual(fs.aborted, ["vaults/default/target/b"]);
  assert.deepEqual(fs.removed, ["vaults/default/target"]);
  await backend.close();
});

test("source reads and target close failures never delete the source", async () => {
  const { fs, backend, write } = await setup();
  await write("source");
  fs.onRead = (path) => {
    if (path.endsWith("/source"))
      throw new DOMException("Read failed", "NotReadableError");
  };
  const readError = await renameError(
    backend.rename(vaultPath("source"), vaultPath("read-target")),
  );
  assert.equal(readError.code, "IO");
  fs.onRead = undefined;
  fs.onClose = () => {
    throw new DOMException("Close failed", "QuotaExceededError");
  };
  const closeError = await renameError(
    backend.rename(vaultPath("source"), vaultPath("close-target")),
  );
  assert.equal(closeError.code, "QuotaExceeded");
  assert.equal(closeError.phase, "copy");
  assert.deepEqual(
    Array.from(await backend.readFile(vaultPath("source"))),
    [1, 2, 3],
  );
  assert.equal(await backend.stat(vaultPath("read-target")), null);
  assert.equal(await backend.stat(vaultPath("close-target")), null);
  assert.ok(!fs.removed.includes("vaults/default/source"));
  await backend.close();
});

test("abort and target cleanup failures retain the original error and report leftovers", async () => {
  const { fs, backend, write } = await setup();
  await write("source");
  fs.onWrite = () => {
    throw new DOMException("Quota exhausted", "QuotaExceededError");
  };
  fs.onAbort = () => {
    throw new DOMException("Abort failed", "UnknownError");
  };
  fs.onRemove = () => {
    throw new DOMException("Cleanup blocked", "NoModificationAllowedError");
  };
  const error = await renameError(
    backend.rename(vaultPath("source"), vaultPath("target")),
  );
  assert.equal(error.code, "QuotaExceeded");
  assert.equal(error.cleanupError?.code, "Busy");
  assert.equal(error.targetComplete, false);
  assert.ok(error.cause instanceof VaultError);
  assert.ok(
    (error.cause.cause as { abortError: unknown }).abortError instanceof
      DOMException,
  );
  assert.deepEqual(
    Array.from(await backend.readFile(vaultPath("source"))),
    [1, 2, 3],
  );
  assert.equal((await backend.stat(vaultPath("target")))?.size, 0);
  await backend.close();
});

test("a source stream failing after a chunk aborts the target and leaves the source intact", async () => {
  const { fs, backend, write } = await setup();
  await write("source");
  fs.onStreamPull = (_path, offset) => {
    if (offset >= 2)
      throw new DOMException("Stream read failed", "NotReadableError");
  };
  const error = await renameError(
    backend.rename(vaultPath("source"), vaultPath("target")),
  );
  assert.equal(error.phase, "copy");
  assert.equal(error.code, "IO");
  assert.equal(await backend.stat(vaultPath("target")), null);
  assert.deepEqual(
    Array.from(await backend.readFile(vaultPath("source"))),
    [1, 2, 3],
  );
  assert.deepEqual(fs.aborted, ["vaults/default/target"]);
  await backend.close();
});

test("a partially failed source deletion preserves the complete destination", async () => {
  const { fs, backend, write } = await setup();
  await backend.mkdir(vaultPath("source"));
  await write("source/a");
  await write("source/b", [9]);
  const vaults = await fs.root.getDirectoryHandle("vaults");
  const root = await vaults.getDirectoryHandle("default");
  const source = await root.getDirectoryHandle("source");
  fs.onRemove = (path) => {
    if (path.endsWith("/source")) {
      source.children.delete("a");
      throw new DOMException("Source is busy", "NoModificationAllowedError");
    }
  };
  const error = await renameError(
    backend.rename(vaultPath("source"), vaultPath("target")),
  );
  assert.equal(error.phase, "remove-source");
  assert.equal(error.targetComplete, true);
  assert.equal(error.code, "Busy");
  assert.equal(error.cleanupError, undefined);
  assert.equal(await backend.stat(vaultPath("source/a")), null);
  assert.deepEqual(
    Array.from(await backend.readFile(vaultPath("target/a"))),
    [1, 2, 3],
  );
  assert.deepEqual(
    Array.from(await backend.readFile(vaultPath("target/b"))),
    [9],
  );
  assert.ok(!fs.removed.includes("vaults/default/target"));
  await backend.close();
});

test("rename holds one shared write lock through copying and deletion; close drains it", async () => {
  const { fs, backend, write } = await setup();
  await write("source");
  const other = await openOpfsVault();
  const copying = deferred();
  const resume = deferred();
  fs.onWrite = async (path) => {
    if (path.endsWith("/target")) {
      copying.resolve();
      await resume.promise;
    }
  };
  const rename = backend.rename(vaultPath("source"), vaultPath("target"));
  await copying.promise;
  let updated = false;
  let closed = false;
  const queued = other.writeFile(vaultPath("source"), new Uint8Array([9]), {
    mode: "replace",
  });
  // 提前挂 rejection handler，避免期望中的 NotFound 成为未处理拒绝。
  const queuedResult = queued.then(
    () => {
      updated = true;
      return "success";
    },
    (error: VaultError) => error.code,
  );
  const closing = backend.close().then(() => {
    closed = true;
  });
  try {
    await Promise.resolve();
    assert.equal(updated, false);
    assert.equal(closed, false);
    await assert.rejects(
      backend.rename(vaultPath("source"), vaultPath("late")),
      (error: unknown) =>
        error instanceof VaultError && error.code === "Closed",
    );
  } finally {
    resume.resolve();
  }
  await Promise.all([rename, closing]);
  assert.equal(await queuedResult, "NotFound");
  assert.deepEqual(
    Array.from(await other.readFile(vaultPath("target"))),
    [1, 2, 3],
  );
  assert.equal(await other.stat(vaultPath("source")), null);
  await other.close();
});

test("competing renames cannot overwrite the same target and preserve the losing source", async () => {
  const { backend, write } = await setup();
  await write("a", [1]);
  await write("b", [2]);
  const other = await openOpfsVault();
  const results = await Promise.allSettled([
    backend.rename(vaultPath("a"), vaultPath("target")),
    other.rename(vaultPath("b"), vaultPath("target")),
  ]);
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1,
  );
  const failure = results.find((result) => result.status === "rejected");
  assert.ok(
    failure?.status === "rejected" && failure.reason instanceof VaultError,
  );
  assert.equal(failure.reason.code, "AlreadyExists");
  const target = Array.from(await backend.readFile(vaultPath("target")));
  const loser = target[0] === 1 ? "b" : "a";
  assert.deepEqual(
    Array.from(await backend.readFile(vaultPath(loser))),
    target[0] === 1 ? [2] : [1],
  );
  assert.equal((await backend.stat(ROOT_PATH))?.kind, "directory");
  await Promise.all([backend.close(), other.close()]);
});
