import { VaultDocuments } from "../editor/documents";
import { FileTreeModel } from "../file-tree/model";
import type { EditorBuffer } from "../editor/buffer";
import { openAppDocument, type SettingsFile } from "../settings/app-file";
import { openHttpVault, normalizeVaultUrl } from "./http";
import { openLocalEditor, openRemoteEditor } from "../editor/client/documents";
import type { EditorDocuments, InstanceIdentity } from "../editor/contract";
import { VaultError } from "./errors";
import type { VaultBackend } from "./types";
import {
  authorizeDirectory,
  pickLocalDirectory,
  type LocalDirectoryHandle,
} from "./file-system-access";
import {
  IndexedDbDirectoryRegistry,
  type DirectoryRegistry,
} from "./directory-registry";
import type { LocalEditorSource } from "../editor/local/worker";

export const DEFAULT_VAULT_ID = "opfs:default";
export interface VaultConnection {
  id: string;
  kind: "opfs" | "directory" | "remote";
  name: string;
  url?: string;
}
export interface VaultInstance {
  authorize?: (token: string) => Promise<void>;
  identity?: InstanceIdentity;
  id: string;
  name: string;
  backend: VaultBackend;
  documents: EditorDocuments;
  tree: FileTreeModel;
  editorBuffers: Map<string, EditorBuffer>;
  treeView: { scrollTop: number };
  readOnly: boolean;
}
export interface VaultManagerSnapshot {
  connections: readonly VaultConnection[];
  opened: readonly VaultInstance[];
  active: VaultInstance | null;
  opening: boolean;
  error: string | null;
  persistenceError: string | null;
}
interface ManagerOptions {
  file?: SettingsFile;
  openLocal?: () => Promise<VaultBackend>;
  openRemote?: typeof openHttpVault;
  openRemoteEditor?: typeof openRemoteEditor;
  directories?: DirectoryRegistry;
  pickDirectory?: typeof pickLocalDirectory;
  openLocalEditor?: (source: LocalEditorSource) => Promise<{
    identity: InstanceIdentity;
    backend: VaultBackend;
    documents: EditorDocuments;
  }>;
}
const defaultConnection = (): VaultConnection => ({
  id: DEFAULT_VAULT_ID,
  kind: "opfs",
  name: "我的 Vault",
});

/** Owns runtime lifetimes. Switching views never closes or shares editing buffers. */
export class VaultManager {
  private connections: VaultConnection[] = [defaultConnection()];
  private runtimes = new Map<string, VaultInstance>();
  private inflight = new Map<string, Promise<VaultInstance>>();
  private active: VaultInstance | null = null;
  private opening = false;
  private error: string | null = null;
  private persistenceError: string | null = null;
  private listeners = new Set<(state: VaultManagerSnapshot) => void>();
  private selection = 0;
  private disposed = false;
  private persistence: Promise<unknown> = Promise.resolve();
  private removals = new Set<string>();
  private file?: SettingsFile;
  private initialization?: Promise<void>;
  private directories?: DirectoryRegistry;
  private directoryHandles = new Map<string, LocalDirectoryHandle>();
  private directoryError: string | null = null;
  constructor(private options: ManagerOptions = {}) {
    this.file = options.file;
    this.directories =
      options.directories ??
      (typeof indexedDB === "undefined"
        ? undefined
        : new IndexedDbDirectoryRegistry());
  }
  snapshot(): VaultManagerSnapshot {
    return {
      connections: [...this.connections],
      opened: [...this.runtimes.values()],
      active: this.active,
      opening: this.opening,
      error: this.error,
      persistenceError:
        [this.persistenceError, this.directoryError]
          .filter(Boolean)
          .join(" ") || null,
    };
  }
  subscribe(listener: (state: VaultManagerSnapshot) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private notify() {
    if (!this.disposed)
      for (const listener of this.listeners) listener(this.snapshot());
  }
  initialize(): Promise<void> {
    return (this.initialization ??= this.load());
  }
  private async load() {
    try {
      this.file ??= await openAppDocument("connections.json");
      const text = await this.file.read();
      if (text) {
        const document = JSON.parse(text);
        if (document.version !== 1 || !Array.isArray(document.connections))
          throw new Error("连接记录格式无效。");
        const seen = new Set<string>();
        for (const connection of document.connections) {
          if (
            typeof connection.url !== "string" ||
            typeof connection.name !== "string"
          )
            throw new Error("连接记录格式无效。");
          const url = normalizeVaultUrl(connection.url);
          const id = "remote:" + url;
          if (!seen.has(id)) {
            seen.add(id);
            this.connections.push({
              id,
              kind: "remote",
              name: connection.name,
              url,
            });
          }
        }
      }
      if (this.file.persistent === false)
        this.persistenceError = "连接记录仅保留在本次会话。";
    } catch (error) {
      this.persistenceError = `无法读取连接记录：${message(error)}`;
    }
    try {
      for (const record of (await this.directories?.list()) ?? []) {
        this.directoryHandles.set(record.id, record.handle);
        this.connections.push({
          id: record.id,
          kind: "directory",
          name: record.name,
        });
      }
    } catch (error) {
      this.directoryError = `无法读取本机目录记录：${message(error)}`;
    }
    if (this.disposed) return;
    this.notify();
    await this.activate(DEFAULT_VAULT_ID);
  }
  private build(
    connection: VaultConnection,
    backend: VaultBackend,
    readOnly = false,
  ): VaultInstance {
    const documents = new VaultDocuments(backend, 800, readOnly);
    return {
      id: connection.id,
      name: connection.name,
      backend,
      documents,
      tree: new FileTreeModel(documents.treeBackend),
      editorBuffers: new Map(),
      treeView: { scrollTop: 0 },
      readOnly,
    };
  }
  private open(connection: VaultConnection): Promise<VaultInstance> {
    const existing = this.runtimes.get(connection.id);
    if (existing) return Promise.resolve(existing);
    const pending = this.inflight.get(connection.id);
    if (pending) return pending;
    const operation = (async () => {
      let vault: VaultInstance;
      if (connection.kind !== "remote") {
        if (connection.kind === "opfs" && this.options.openLocal)
          vault = this.build(connection, await this.options.openLocal());
        else {
          const source: LocalEditorSource =
            connection.kind === "opfs"
              ? { kind: "opfs", id: "default" }
              : {
                  kind: "directory",
                  id: connection.id,
                  handle: this.directoryHandle(connection.id),
                };
          const { identity, backend, documents } = await (
            this.options.openLocalEditor ?? openLocalEditor
          )(source);
          vault = {
            id: connection.id,
            name: connection.name,
            identity,
            backend,
            documents,
            tree: new FileTreeModel(backend),
            editorBuffers: new Map(),
            treeView: { scrollTop: 0 },
            readOnly: false,
          };
        }
      } else {
        const { backend, descriptor } = await (
          this.options.openRemote ?? openHttpVault
        )(connection.url!);
        connection.name = descriptor.name;
        vault = await this.buildRemote(
          connection,
          backend,
          descriptor.readOnly,
        );
      }
      if (this.disposed || this.removals.has(connection.id)) {
        await vault.documents.close();
        vault.tree.dispose();
        throw new VaultError("Closed", "Vault is closed");
      }
      this.runtimes.set(connection.id, vault);
      this.notify();
      return vault;
    })();
    this.inflight.set(connection.id, operation);
    void operation.then(
      () => this.inflight.delete(connection.id),
      () => this.inflight.delete(connection.id),
    );
    return operation;
  }
  async activate(id: string): Promise<boolean> {
    const connection = this.connections.find((c) => c.id === id);
    if (!connection || this.disposed || this.removals.has(id)) return false;
    const authorization =
      connection.kind === "directory"
        ? authorizeDirectory(this.directoryHandle(id))
        : undefined;
    const request = ++this.selection;
    this.opening = true;
    this.error = null;
    this.notify();
    try {
      await authorization;
      const vault = await this.open(connection);
      if (connection.kind === "directory")
        await vault.documents.observeFiles?.();
      if (request !== this.selection || this.disposed) return false;
      this.active = vault;
      this.error = null;
      return true;
    } catch (error) {
      if (request === this.selection)
        this.error = `无法打开 ${connection.name}：${message(error)}`;
      return false;
    } finally {
      if (request === this.selection) {
        this.opening = false;
        this.notify();
      }
    }
  }
  private directoryHandle(id: string): LocalDirectoryHandle {
    const handle = this.directoryHandles.get(id);
    if (!handle)
      throw new VaultError("NotFound", "目录记录已不存在，请重新选择目录。");
    return handle;
  }
  async openDirectory(): Promise<boolean> {
    if (this.disposed) throw new VaultError("Closed", "Vault 管理器已关闭。");
    const request = ++this.selection;
    this.opening = true;
    this.error = null;
    this.notify();
    try {
      // Picker runs before any storage IO, preserving the click's activation.
      const handle = await (this.options.pickDirectory ?? pickLocalDirectory)();
      if (!handle || this.disposed) return false;
      if (!this.directories)
        throw new VaultError("Unsupported", "浏览器无法保存本机目录身份。");
      const record = await this.directories.remember(handle);
      if (this.disposed || this.removals.has(record.id)) return false;
      this.directoryHandles.set(record.id, record.handle);
      let connection = this.connections.find((entry) => entry.id === record.id);
      if (!connection) {
        connection = { id: record.id, name: record.name, kind: "directory" };
        this.connections.push(connection);
      }
      connection.name = record.name;
      this.directoryError = null;
      const vault = await this.open(connection);
      vault.name = record.name;
      if (request !== this.selection || this.disposed) return false;
      this.active = vault;
      return true;
    } catch (error) {
      if (request === this.selection) this.error = message(error);
      throw error;
    } finally {
      if (request === this.selection) this.opening = false;
      this.notify();
    }
  }
  async connect(value: string, token = ""): Promise<boolean> {
    const url = normalizeVaultUrl(value);
    const id = "remote:" + url;
    if (this.removals.has(id) || this.disposed)
      throw new VaultError("Closed", "Vault is closing");
    const request = ++this.selection;
    this.opening = true;
    this.error = null;
    this.notify();
    try {
      const { backend, descriptor } = await (
        this.options.openRemote ?? openHttpVault
      )(url, token);
      if (this.disposed || this.removals.has(id)) {
        await backend.close();
        return false;
      }
      let connection = this.connections.find((c) => c.id === id);
      if (!connection) {
        connection = { id, kind: "remote", name: descriptor.name, url };
        this.connections.push(connection);
      }
      connection.name = descriptor.name;
      let vault = this.runtimes.get(id);
      if (vault) {
        try {
          await vault.authorize?.(token);
        } finally {
          await backend.close();
        }
        vault.name = descriptor.name;
        vault.readOnly = descriptor.readOnly;
      } else {
        vault = await this.buildRemote(
          connection,
          backend,
          descriptor.readOnly,
          token,
        );
        this.runtimes.set(id, vault);
      }
      if (request === this.selection) this.active = vault;
      await this.persist();
      return true;
    } catch (error) {
      if (request === this.selection) this.error = message(error);
      throw error;
    } finally {
      if (request === this.selection) this.opening = false;
      this.notify();
    }
  }
  private async buildRemote(
    connection: VaultConnection,
    http: VaultBackend,
    readOnly: boolean,
    token = "",
  ): Promise<VaultInstance> {
    const editor = await (this.options.openRemoteEditor ?? openRemoteEditor)(
      connection.url!,
      token,
      http,
    );
    return {
      id: connection.id,
      name: connection.name,
      ...editor,
      tree: new FileTreeModel(editor.backend),
      editorBuffers: new Map(),
      treeView: { scrollTop: 0 },
      readOnly,
    };
  }
  /** Removing a connection never calls backend.remove(). The default entry is structural. */
  async removeConnection(id: string): Promise<void> {
    if (id === DEFAULT_VAULT_ID)
      throw new VaultError("PermissionDenied", "默认本地 Vault 不可移除。");
    if (this.removals.has(id) || this.disposed) return;
    this.removals.add(id);
    try {
      const pending = this.inflight.get(id);
      if (pending) await pending.catch(() => {});
      const vault = this.runtimes.get(id);
      if (
        vault &&
        !vault.documents.reconnect &&
        !(await vault.documents.saveAll())
      )
        throw new VaultError("IO", "存在未能保存的编辑，连接仍保留。");
      const fallback =
        this.active?.id === id
          ? await this.open(
              this.connections.find((c) => c.id === DEFAULT_VAULT_ID)!,
            )
          : undefined;
      if (vault) {
        await vault.documents.close();
        vault.tree.dispose();
        vault.editorBuffers.clear();
      }
      if (this.active?.id === id && fallback) {
        this.selection++;
        this.opening = false;
        this.active = fallback;
      }
      this.runtimes.delete(id);
      if (this.directoryHandles.has(id)) {
        await this.directories!.forget(id);
        this.directoryHandles.delete(id);
      }
      this.connections = this.connections.filter((c) => c.id !== id);
      await this.persist();
      this.notify();
    } finally {
      this.removals.delete(id);
      this.notify();
    }
  }
  private persist(): Promise<void> {
    const document = {
      version: 1,
      connections: this.connections
        .filter((c) => c.kind === "remote")
        .map((c) => ({ url: c.url, name: c.name })),
    };
    const operation = this.persistence.then(async () => {
      try {
        if (!this.file) throw new Error("本地存储不可用。");
        await this.file.write(document);
        this.persistenceError =
          this.file.persistent === false ? "连接记录仅保留在本次会话。" : null;
      } catch (error) {
        this.persistenceError = `连接记录未保存：${message(error)}`;
      }
      this.notify();
    });
    this.persistence = operation;
    return operation;
  }
  async close() {
    if (this.disposed) return;
    this.disposed = true;
    this.selection++;
    await Promise.allSettled([...this.inflight.values()]);
    await Promise.allSettled(
      [...this.runtimes.values()].map((v) => v.documents.close()),
    );
    for (const vault of this.runtimes.values()) {
      vault.tree.dispose();
      vault.editorBuffers.clear();
    }
    await this.persistence;
    this.listeners.clear();
  }
}
function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
