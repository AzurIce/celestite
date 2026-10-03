import { isWithin, describeTreeError } from "../file-tree/model";
import { vaultPath, VaultError } from "../vault";
import type { VaultBackend, VaultPath } from "../vault";

export const MAX_EDITABLE_BYTES = 5 * 1024 * 1024;

export interface DocumentSnapshot {
  id: string;
  path: VaultPath;
  content: string;
  dirty: boolean;
  saving: boolean;
  locked: boolean;
  error: string | null;
  readOnlyReason: string | null;
  lineEnding: "\n" | "\r\n" | "\r";
  bom: boolean;
}
export interface DocumentsSnapshot {
  documents: readonly DocumentSnapshot[];
  activeId: string | null;
  loadingPath: VaultPath | null;
  openError: string | null;
  activation: number;
}
interface DocumentRecord extends Omit<DocumentSnapshot, "dirty"> {
  savedContent: string;
  firstDirtyAt: number | null;
  timer?: ReturnType<typeof setTimeout>;
}

export function decodeText(bytes: Uint8Array) {
  const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  const raw = new TextDecoder("utf-8", { fatal: true }).decode(
    bom ? bytes.subarray(3) : bytes,
  );
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(raw))
    throw new Error("Binary file");
  const lineEnding = (raw.match(/\r\n|\r|\n/)?.[0] ??
    "\n") as DocumentSnapshot["lineEnding"];
  return { content: raw.replace(/\r\n?|\n/g, "\n"), bom, lineEnding };
}
export function encodeText(
  document: Pick<DocumentSnapshot, "content" | "bom" | "lineEnding">,
) {
  return new TextEncoder().encode(
    (document.bom ? "\ufeff" : "") +
      document.content.replace(/\n/g, document.lineEnding),
  );
}

/** 编辑缓冲区与视图解耦；保存及文件树修改在同一运行时队列中执行。 */
export class VaultDocuments {
  private readonly records = new Map<string, DocumentRecord>();
  private readonly listeners = new Set<(state: DocumentsSnapshot) => void>();
  private readonly saves = new Map<string, Promise<boolean>>();
  private queue: Promise<unknown> = Promise.resolve();
  private nextId = 0;
  private request = 0;
  private activeId: string | null = null;
  private activation = 0;
  private loadingPath: VaultPath | null = null;
  private openError: string | null = null;
  private cached?: DocumentsSnapshot;
  private closing = false;
  private closed = false;
  private closePromise?: Promise<void>;
  readonly treeBackend: VaultBackend;

  constructor(
    private readonly backend: VaultBackend,
    private readonly autosaveDelay = 800,
  ) {
    this.treeBackend = {
      readDir: (path) => backend.readDir(path),
      stat: (path) => backend.stat(path),
      watch: (listener) => backend.watch(listener),
      mkdir: (path, options) =>
        this.fileOperation(() => backend.mkdir(path, options)),
      writeFile: (path, bytes, options) =>
        this.fileOperation(() => backend.writeFile(path, bytes, options)),
      // 下载和复制也先保存该文件的编辑缓冲区。
      readFile: (path) =>
        this.fileOperation(() =>
          this.withLocked([path], async () => {
            await this.persistAffected(path);
            return backend.readFile(path);
          }),
        ),
      rename: (from, to) =>
        this.fileOperation(() =>
          this.withLocked([from], async () => {
            await this.persistAffected(from);
            await backend.rename(from, to);
            for (const record of this.records.values()) {
              if (isWithin(record.path, from))
                record.path = vaultPath(to + record.path.slice(from.length));
            }
            this.notify();
          }),
        ),
      remove: (path, options) =>
        this.fileOperation(() =>
          this.withLocked([path], async () => {
            await this.persistAffected(path);
            await backend.remove(path, options);
            for (const record of [...this.records.values()]) {
              if (isWithin(record.path, path)) this.forget(record.id);
            }
            this.notify();
          }),
        ),
      close: () => this.close(),
    };
  }
  snapshot(): DocumentsSnapshot {
    return (this.cached ??= {
      activeId: this.activeId,
      activation: this.activation,
      loadingPath: this.loadingPath,
      openError: this.openError,
      documents: [...this.records.values()].map((record) => ({
        id: record.id,
        path: record.path,
        content: record.content,
        dirty: record.content !== record.savedContent,
        saving: record.saving,
        locked: record.locked,
        error: record.error,
        readOnlyReason: record.readOnlyReason,
        lineEnding: record.lineEnding,
        bom: record.bom,
      })),
    });
  }
  subscribe(listener: (state: DocumentsSnapshot) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private notify() {
    this.cached = undefined;
    if (!this.closed)
      this.listeners.forEach((listener) => listener(this.snapshot()));
  }
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task);
    this.queue = result.catch(() => {});
    return result;
  }
  private fileOperation<T>(task: () => Promise<T>) {
    if (this.closing)
      return Promise.reject(new VaultError("Closed", "Vault is closing"));
    return this.enqueue(task);
  }
  private cancelTimer(record: DocumentRecord) {
    clearTimeout(record.timer);
    record.timer = undefined;
  }
  private schedule(record: DocumentRecord) {
    this.cancelTimer(record);
    if (
      record.content === record.savedContent ||
      record.readOnlyReason ||
      record.error ||
      this.closing
    )
      return;
    record.firstDirtyAt ??= Date.now();
    // 连续输入时至多等待五秒，避免 debounce 无限推迟持久化。
    const delay = Math.min(
      this.autosaveDelay,
      Math.max(0, 5000 - (Date.now() - record.firstDirtyAt)),
    );
    record.timer = setTimeout(() => {
      void this.save(record.id);
    }, delay);
  }
  hasUnsaved() {
    return [...this.records.values()].some(
      (record) => record.saving || record.content !== record.savedContent,
    );
  }
  has(id: string) {
    return this.records.has(id);
  }
  activate(id: string) {
    if (!this.records.has(id) || this.closing) return;
    this.request++;
    this.loadingPath = null;
    this.openError = null;
    this.activeId = id;
    this.activation++;
    this.notify();
  }
  async open(path: VaultPath): Promise<boolean> {
    if (this.closing) return false;
    const existing = [...this.records.values()].find(
      (record) => record.path === path,
    );
    if (existing) {
      this.activate(existing.id);
      return true;
    }
    const request = ++this.request;
    this.activation++;
    this.loadingPath = path;
    this.openError = null;
    this.notify();
    return this.enqueue(async () => {
      if (request !== this.request || this.closing) return false;
      try {
        const stat = await this.backend.stat(path);
        if (!stat || stat.kind !== "file")
          throw new VaultError("NotFound", "File does not exist", path);
        let text = {
          content: "",
          bom: false,
          lineEnding: "\n" as DocumentSnapshot["lineEnding"],
        };
        let readOnlyReason: string | null = null;
        if ((stat.size ?? 0) > MAX_EDITABLE_BYTES)
          readOnlyReason = "文件超过 5 MiB，请通过文件树下载后编辑。";
        else {
          const bytes = await this.backend.readFile(path);
          if (bytes.length > MAX_EDITABLE_BYTES)
            readOnlyReason = "文件超过 5 MiB，请通过文件树下载后编辑。";
          else {
            try {
              text = decodeText(bytes);
            } catch {
              readOnlyReason =
                "这个文件不是 UTF-8 文本，无法在此编辑。可通过文件树下载。";
            }
          }
        }
        if (request !== this.request || this.closing) return false;
        const record: DocumentRecord = {
          ...text,
          id: `document-${++this.nextId}`,
          path,
          savedContent: text.content,
          saving: false,
          locked: false,
          error: null,
          readOnlyReason,
          firstDirtyAt: null,
        };
        this.records.set(record.id, record);
        this.activeId = record.id;
        return true;
      } catch (error) {
        if (request === this.request)
          this.openError = `${path}：${describeTreeError(error)}`;
        return false;
      } finally {
        if (request === this.request) {
          this.loadingPath = null;
          this.notify();
        }
      }
    });
  }
  update(id: string, content: string): boolean {
    const record = this.records.get(id);
    if (!record || record.locked || record.readOnlyReason || this.closing)
      return false;
    if (record.content === content) return true;
    record.content = content;
    if (record.content === record.savedContent) {
      record.firstDirtyAt = null;
      record.error = null;
    }
    this.schedule(record);
    this.notify();
    return true;
  }
  save(id = this.activeId): Promise<boolean> {
    const record = id ? this.records.get(id) : undefined;
    if (!record || record.readOnlyReason || this.closed)
      return Promise.resolve(false);
    const pending = this.saves.get(record.id);
    if (pending) return pending;
    this.cancelTimer(record);
    const result = this.enqueue(() =>
      this.records.has(record.id)
        ? this.persist(record)
        : Promise.resolve(true),
    );
    this.saves.set(record.id, result);
    void result.then(() => {
      this.saves.delete(record.id);
    });
    return result;
  }
  async saveAll() {
    const results = await Promise.all(
      [...this.records.values()]
        .filter((record) => !record.readOnlyReason)
        .map((record) => this.save(record.id)),
    );
    return results.every(Boolean);
  }
  private async persist(record: DocumentRecord): Promise<boolean> {
    this.cancelTimer(record);
    if (record.content === record.savedContent) return true;
    record.saving = true;
    record.error = null;
    this.notify();
    try {
      while (record.content !== record.savedContent) {
        const content = record.content;
        await this.backend.writeFile(
          record.path,
          encodeText({ ...record, content }),
          { mode: "replace" },
        );
        // 写入期间可能继续输入；只有真正提交的版本才算已保存。
        record.savedContent = content;
        this.notify();
      }
      record.firstDirtyAt = null;
      return true;
    } catch (error) {
      record.error = describeTreeError(error);
      return false;
    } finally {
      this.cancelTimer(record);
      record.saving = false;
      this.notify();
    }
  }
  private async persistAffected(path: VaultPath) {
    for (const record of this.records.values()) {
      if (isWithin(record.path, path) && !(await this.persist(record)))
        throw new VaultError(
          "IO",
          "Cannot change a file whose edits could not be saved",
          record.path,
        );
    }
  }
  private async withLocked<T>(
    paths: readonly VaultPath[],
    task: () => Promise<T>,
  ) {
    const records = [...this.records.values()].filter((record) =>
      paths.some((path) => isWithin(record.path, path)),
    );
    for (const record of records) {
      record.locked = true;
      this.cancelTimer(record);
    }
    this.notify();
    try {
      return await task();
    } finally {
      for (const record of records) {
        record.locked = false;
        this.schedule(record);
      }
      this.notify();
    }
  }
  private forget(id: string) {
    const record = this.records.get(id);
    if (!record) return;
    this.cancelTimer(record);
    this.records.delete(id);
    if (this.activeId === id)
      this.activeId = [...this.records.keys()].slice(-1)[0] ?? null;
  }
  async closeDocument(id: string): Promise<boolean> {
    const record = this.records.get(id);
    if (!record || this.closing) return false;
    return this.enqueue(() =>
      this.withLocked([record.path], async () => {
        if (!(await this.persist(record))) {
          this.activate(id);
          return false;
        }
        this.forget(id);
        this.notify();
        return true;
      }),
    );
  }
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.request++;
    for (const record of this.records.values()) this.cancelTimer(record);
    return (this.closePromise = (async () => {
      await this.saveAll();
      await this.queue;
      this.closed = true;
      this.listeners.clear();
      await this.backend.close();
    })());
  }
}
