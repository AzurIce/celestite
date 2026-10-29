import { FileTreeModel } from "../file-tree/model";
import { openAppDocument, type SettingsFile } from "../settings/app-file";
import { openHttpVault, normalizeVaultUrl } from "./http";
import type { HttpVaultBackend, RemoteVaultDescriptor } from "./http";
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
import { isDesktop, desktopInvoke } from "../desktop/platform";
import { openNativeEditor } from "../desktop/editor";
import { remoteGitStatus } from "../git/source";
import type { GitStatusSource } from "../git/status";

export const DEFAULT_VAULT_ID = "opfs:default";
export interface VaultConnection {
  id: string;
  kind: "opfs" | "native" | "directory" | "remote";
  name: string;
  url?: string;
  directoryPath?: string;
}
export interface VaultInstance {
  authorizeResources?: () => Promise<void>;
  identity?: InstanceIdentity;
  id: string;
  name: string;
  backend: VaultBackend;
  documents: EditorDocuments;
  git?: GitStatusSource;
  tree: FileTreeModel;
  treeView: { scrollTop: number };
  readOnly: boolean;
  /** 本地 Vault 的绝对根目录；浏览器或远端 Vault 为 null。 */
  root?: string | null;
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
  native?: {
    openEditor: typeof openNativeEditor;
    pickDirectory: () => Promise<string | null>;
  };
  file?: SettingsFile;
  openRemote?: typeof openHttpVault;
  openRemoteEditor?: typeof openRemoteEditor;
  directories?: DirectoryRegistry;
  pickDirectory?: typeof pickLocalDirectory;
  openLocalEditor?: typeof openLocalEditor;
}
const defaultConnection = (native: boolean): VaultConnection => ({
  id: native ? "native:default" : DEFAULT_VAULT_ID,
  kind: native ? "native" : "opfs",
  name: "我的 Vault",
});

/** Owns runtime lifetimes. Switching views never closes or shares editing buffers. */
export class VaultManager {
  readonly defaultId: string;
  private connections: VaultConnection[];
  private runtimes = new Map<string, VaultInstance>();
  private inflight = new Map<string, Promise<VaultInstance>>();
  private connecting = new Map<string, Promise<boolean>>();
  private active: VaultInstance | null = null;
  private opening = false;
  private error: string | null = null;
  private persistenceError: string | null = null;
  private listeners = new Set<(state: VaultManagerSnapshot) => void>();
  private selection = 0;
  private disposed = false;
  private preparing = false;
  private preparation?: Promise<boolean>;
  private accepted = new Set<Promise<unknown>>();
  private closePromise?: Promise<void>;
  private persistence: Promise<unknown> = Promise.resolve();
  private pendingPersistence = false;
  private connectionsLoaded = false;
  private removals = new Set<string>();
  private file?: SettingsFile;
  private initialization?: Promise<void>;
  private directories?: DirectoryRegistry;
  private directoryHandles = new Map<string, LocalDirectoryHandle>();
  private resourceScopes = new Map<string, LocalDirectoryHandle>();
  private resourceSetters = new Map<
    string,
    (scope: FileSystemDirectoryHandle) => Promise<void>
  >();
  private directoryError: string | null = null;
  private native?: ManagerOptions["native"];
  constructor(private options: ManagerOptions = {}) {
    this.file = options.file;
    this.native =
      options.native ??
      (isDesktop()
        ? {
            openEditor: openNativeEditor,
            pickDirectory: () =>
              desktopInvoke<string | null>("desktop_pick_directory"),
          }
        : undefined);
    const connection = defaultConnection(!!this.native);
    this.defaultId = connection.id;
    this.connections = [connection];
    this.directories =
      options.directories ??
      (this.native || typeof indexedDB === "undefined"
        ? undefined
        : new IndexedDbDirectoryRegistry());
  }
  snapshot(): VaultManagerSnapshot {
    return {
      connections: [...this.connections],
      opened: [...this.runtimes.values()],
      active: this.active,
      opening: this.opening || this.preparing,
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
  private accept<T>(operation: () => Promise<T>): Promise<T> {
    if (this.disposed)
      return Promise.reject(new VaultError("Closed", "Vault 管理器已关闭。"));
    if (this.preparing)
      return Promise.reject(
        new VaultError("Busy", "工作区正在等待关闭，请稍后重试。"),
      );
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const pending = new Promise<T>((accepted, failed) => {
      resolve = accepted;
      reject = failed;
    });
    this.accepted.add(pending);
    void pending.then(
      () => this.accepted.delete(pending),
      () => this.accepted.delete(pending),
    );
    try {
      // Register first for synchronous subscribers, then start immediately to
      // retain the user gesture required by browser directory pickers.
      void operation().then(resolve, reject);
    } catch (error) {
      reject(error);
    }
    return pending;
  }
  initialize(): Promise<void> {
    if (!this.initialization && (this.disposed || this.preparing))
      return this.accept(() => this.load());
    return (this.initialization ??= this.accept(() => this.load()));
  }
  private async load() {
    try {
      this.file ??= await openAppDocument("connections.json");
      this.connections.push(
        ...readConnections(await this.file.read(), !!this.native),
      );
      this.connectionsLoaded = true;
      if (this.file.persistent === false)
        this.persistenceError = "连接记录仅保留在本次会话。";
    } catch (error) {
      this.persistenceError = `无法读取连接记录：${message(error)}`;
    }
    try {
      for (const record of (await this.directories?.list()) ?? []) {
        this.directoryHandles.set(record.id, record.handle);
        if (record.resourceScope)
          this.resourceScopes.set(record.id, record.resourceScope);
        this.connections.push({
          id: record.id,
          kind: "directory",
          name: record.name,
          directoryPath: await directoryDisplayPath(
            record.handle,
            record.resourceScope,
          ),
        });
      }
    } catch (error) {
      this.directoryError = `无法读取本机目录记录：${message(error)}`;
    }
    if (this.disposed) return;
    this.notify();
    await this.activateConnection(this.defaultId);
  }
  private open(connection: VaultConnection): Promise<VaultInstance> {
    const existing = this.runtimes.get(connection.id);
    if (existing) return Promise.resolve(existing);
    const pending = this.inflight.get(connection.id);
    if (pending) return pending;
    const operation = (async () => {
      let vault: VaultInstance;
      let resourceSetter:
        ((scope: FileSystemDirectoryHandle) => Promise<void>) | undefined;
      if (connection.kind !== "remote") {
        const local = this.native
          ? await this.native.openEditor(
              connection.kind === "opfs" || connection.kind === "native"
                ? { kind: "default" }
                : { kind: "directory", path: connection.directoryPath! },
            )
          : await (this.options.openLocalEditor ?? openLocalEditor)(
              connection.kind === "opfs" || connection.kind === "native"
                ? { kind: "opfs", id: "default" }
                : {
                    kind: "directory",
                    id: connection.id,
                    handle: this.directoryHandle(connection.id),
                    resourceScope: this.resourceScopes.get(connection.id),
                  },
            );
        const { identity, backend, documents } = local;
        const root = "root" in local ? local.root : null;
        const setResourceScope =
          "setResourceScope" in local
            ? (local.setResourceScope as
                | ((scope: FileSystemDirectoryHandle) => Promise<void>)
                | undefined)
            : undefined;
        const git = "git" in local ? local.git : undefined;
        resourceSetter = setResourceScope;
        vault = {
          id: connection.id,
          name: connection.name,
          identity,
          backend,
          documents,
          git,
          tree: new FileTreeModel(backend),
          treeView: { scrollTop: 0 },
          readOnly: false,
          root,
          ...(setResourceScope
            ? {
                authorizeResources: () =>
                  this.authorizeResources(connection.id, setResourceScope),
              }
            : {}),
        };
      } else {
        const { backend, descriptor } = await (
          this.options.openRemote ?? openHttpVault
        )(connection.url!);
        connection.name = descriptor.name;
        vault = await this.buildRemote(connection, backend, descriptor);
      }
      if (this.disposed || this.removals.has(connection.id)) {
        await vault.documents.close();
        vault.tree.dispose();
        throw new VaultError("Closed", "Vault is closed");
      }
      this.runtimes.set(connection.id, vault);
      if (resourceSetter)
        this.resourceSetters.set(connection.id, resourceSetter);
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
  activate(id: string): Promise<boolean> {
    if (this.disposed || this.preparing) return Promise.resolve(false);
    return this.accept(() => this.activateConnection(id));
  }
  private async activateConnection(id: string): Promise<boolean> {
    const connection = this.connections.find((c) => c.id === id);
    if (!connection || this.disposed || this.removals.has(id)) return false;
    const authorization =
      connection.kind === "directory" && !this.native
        ? authorizeDirectory(this.directoryHandle(id))
        : undefined;
    // Start both prompts during the click; losing an optional resource grant must not block editing.
    const scope = this.resourceScopes.get(id);
    const resourceAuthorization = scope
      ? authorizeDirectory(scope, "read").then(
          () => true,
          () => false,
        )
      : undefined;
    const request = ++this.selection;
    this.opening = true;
    this.error = null;
    this.notify();
    try {
      await authorization;
      const restoreResources = await resourceAuthorization;
      const vault = await this.open(connection);
      if (restoreResources && scope)
        await this.resourceSetters
          .get(id)?.(scope)
          .catch(() => {});
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
  openDirectory(): Promise<boolean> {
    return this.accept(() => this.selectDirectory());
  }
  private async selectDirectory(): Promise<boolean> {
    if (this.disposed) throw new VaultError("Closed", "Vault 管理器已关闭。");
    const request = ++this.selection;
    this.opening = true;
    this.error = null;
    this.notify();
    try {
      // Picker runs before any storage IO, preserving the click's activation.
      if (this.native) {
        const path = await this.native.pickDirectory();
        if (!path || this.disposed) return false;
        const existing = this.connections.find(
          (entry) => entry.kind === "directory" && entry.directoryPath === path,
        );
        if (existing) {
          const vault = await this.open(existing);
          if (request !== this.selection || this.disposed) return false;
          this.active = vault;
          return true;
        }
        const editor = await this.native.openEditor({
          kind: "directory",
          path,
        });
        const current = [...this.runtimes.values()].find(
          (vault) => vault.identity?.instanceId === editor.identity.instanceId,
        );
        if (current) {
          if (request !== this.selection || this.disposed) return false;
          this.active = current;
          return true;
        }
        const id = `directory:${editor.identity.instanceId}`;
        if (this.disposed || this.removals.has(id)) {
          await editor.documents.close();
          return false;
        }
        let connection = this.connections.find((entry) => entry.id === id);
        const root = editor.root ?? path;
        const name =
          root
            .replace(/[\\/]+$/, "")
            .split(/[\\/]/)
            .pop() || root;
        if (!connection) {
          connection = { id, kind: "directory", name, directoryPath: root };
          this.connections.push(connection);
        }
        const vault: VaultInstance = {
          id,
          name: connection.name,
          ...editor,
          tree: new FileTreeModel(editor.backend),
          treeView: { scrollTop: 0 },
          readOnly: false,
        };
        this.runtimes.set(id, vault);
        await this.persist();
        if (request !== this.selection || this.disposed) return false;
        this.active = vault;
        return true;
      }
      const handle = await (this.options.pickDirectory ?? pickLocalDirectory)();
      if (!handle || this.disposed) return false;
      if (!this.directories)
        throw new VaultError("Unsupported", "浏览器无法保存本机目录身份。");
      const record = await this.directories.remember(handle);
      if (this.disposed || this.removals.has(record.id)) return false;
      this.directoryHandles.set(record.id, record.handle);
      if (record.resourceScope)
        this.resourceScopes.set(record.id, record.resourceScope);
      let connection = this.connections.find((entry) => entry.id === record.id);
      if (!connection) {
        connection = { id: record.id, name: record.name, kind: "directory" };
        this.connections.push(connection);
      }
      connection.name = record.name;
      connection.directoryPath = await directoryDisplayPath(
        record.handle,
        record.resourceScope,
      );
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
  connect(value: string): Promise<boolean> {
    return this.accept(() => this.connectValue(value));
  }
  private async connectValue(value: string): Promise<boolean> {
    const url = normalizeVaultUrl(value);
    const pending = this.connecting.get(url);
    if (pending) return pending;
    const operation = this.connectRemote(url);
    this.connecting.set(url, operation);
    void operation.then(
      () => this.connecting.delete(url),
      () => this.connecting.delete(url),
    );
    return operation;
  }
  private async connectRemote(url: string): Promise<boolean> {
    const id =
      this.connections.find((connection) => connection.url === url)?.id ??
      "remote:" + crypto.randomUUID();
    if (this.removals.has(id) || this.disposed)
      throw new VaultError("Closed", "Vault is closing");
    const request = ++this.selection;
    this.opening = true;
    this.error = null;
    this.notify();
    try {
      const { backend, descriptor } = await (
        this.options.openRemote ?? openHttpVault
      )(url);
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
          await vault.documents.reconnect?.();
        } finally {
          await backend.close();
        }
        vault.name = descriptor.name;
        vault.readOnly = descriptor.readOnly;
      } else {
        vault = await this.buildRemote(connection, backend, descriptor);
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
  private authorizeResources(
    id: string,
    update: (scope: FileSystemDirectoryHandle) => Promise<void>,
  ) {
    return this.accept(() => this.authorizeResourceDirectory(id, update));
  }
  private async authorizeResourceDirectory(
    id: string,
    update: (scope: FileSystemDirectoryHandle) => Promise<void>,
  ) {
    if (this.disposed || this.removals.has(id))
      throw new VaultError("Closed", "Vault 正在关闭。");
    const scope = await (this.options.pickDirectory ?? pickLocalDirectory)(
      "read",
    );
    if (!scope || this.disposed || this.removals.has(id)) return;
    const relative = await scope.resolve(this.directoryHandle(id));
    if (relative === null)
      throw new VaultError("InvalidPath", "请选择包含当前 Vault 的目录。");
    await update(scope);
    if (this.disposed || this.removals.has(id)) return;
    this.resourceScopes.set(id, scope);
    const connection = this.connections.find((entry) => entry.id === id);
    if (connection)
      connection.directoryPath = [scope.name, ...relative].join("/");
    try {
      await this.directories!.setResourceScope(id, scope);
      this.directoryError = null;
    } catch (error) {
      this.directoryError = `依赖目录授权仅保留在本次会话：${message(error)}`;
      throw new VaultError("IO", this.directoryError);
    } finally {
      this.notify();
    }
  }
  private async buildRemote(
    connection: VaultConnection,
    http: HttpVaultBackend,
    descriptor: RemoteVaultDescriptor,
  ): Promise<VaultInstance> {
    const editor = await (this.options.openRemoteEditor ?? openRemoteEditor)(
      connection.url!,
      http,
    );
    return {
      id: connection.id,
      name: connection.name,
      ...editor,
      git: descriptor.capabilities.gitStatus
        ? remoteGitStatus(http)
        : undefined,
      tree: new FileTreeModel(editor.backend),
      treeView: { scrollTop: 0 },
      readOnly: descriptor.readOnly,
    };
  }
  /** Removing a connection never calls backend.remove(). The default entry is structural. */
  removeConnection(id: string): Promise<void> {
    return this.accept(() => this.remove(id));
  }
  private async remove(id: string): Promise<void> {
    if (id === this.defaultId)
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
              this.connections.find((c) => c.id === this.defaultId)!,
            )
          : undefined;
      if (vault) {
        await vault.documents.close();
        vault.tree.dispose();
      }
      if (this.active?.id === id && fallback) {
        this.selection++;
        this.opening = false;
        this.active = fallback;
      }
      this.runtimes.delete(id);
      this.resourceSetters.delete(id);
      if (this.directoryHandles.has(id)) {
        await this.directories!.forget(id);
        this.directoryHandles.delete(id);
        this.resourceScopes.delete(id);
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
    this.pendingPersistence = true;
    const operation = this.persistence.then(async () => {
      try {
        if (!this.file) throw new Error("本地存储不可用。");
        if (!this.connectionsLoaded) {
          const previous = readConnections(
            await this.file.read(),
            !!this.native,
          );
          for (const connection of previous) {
            if (
              !this.connections.some((current) => current.id === connection.id)
            )
              this.connections.push(connection);
          }
          this.connectionsLoaded = true;
        }
        const document = {
          version: 2,
          connections: this.connections
            .filter(
              (c) =>
                c.kind === "remote" || (this.native && c.kind === "directory"),
            )
            .map((c) =>
              c.kind === "directory"
                ? {
                    id: c.id,
                    kind: "directory",
                    path: c.directoryPath,
                    name: c.name,
                  }
                : { id: c.id, url: c.url, name: c.name },
            ),
        };
        await this.file.write(document);
        this.pendingPersistence = false;
        this.persistenceError =
          this.file.persistent === false ? "连接记录仅保留在本次会话。" : null;
      } catch (error) {
        this.pendingPersistence = true;
        this.persistenceError = `连接记录未保存：${message(error)}`;
      }
      this.notify();
    });
    this.persistence = operation;
    return operation;
  }
  prepareClose(): Promise<boolean> {
    if (this.disposed) return Promise.resolve(true);
    if (this.preparation) return this.preparation;
    this.preparing = true;
    this.preparation = this.drainAndPrepare();
    this.notify();
    return this.preparation;
  }
  private async drainAndPrepare(): Promise<boolean> {
    await Promise.allSettled([...this.accepted]);
    let preparing: VaultInstance | undefined;
    try {
      for (const vault of this.runtimes.values()) {
        preparing = vault;
        await vault.documents.prepareClose();
      }
      await this.persistence;
      if (this.pendingPersistence) await this.persist();
      if (this.pendingPersistence)
        throw new Error(this.persistenceError ?? "连接记录未保存。");
      return true;
    } catch (error) {
      this.resumeAfterCloseFailure();
      if (preparing) this.active = preparing;
      this.error = `窗口仍保留：${message(error)}`;
      this.notify();
      return false;
    }
  }
  resumeAfterCloseFailure() {
    this.preparing = false;
    this.preparation = undefined;
    for (const vault of this.runtimes.values())
      vault.documents.resumeAfterCloseFailure();
    this.notify();
  }
  /** Native has confirmed every owner; teardown must issue no further core calls. */
  detach() {
    for (const vault of this.runtimes.values()) {
      vault.documents.detach();
      vault.tree.dispose();
    }
    this.disposed = true;
    this.listeners.clear();
    this.resourceSetters.clear();
  }
  close(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.closePromise) return this.closePromise;
    this.preparing = true;
    this.notify();
    return (this.closePromise = (async () => {
      this.selection++;
      await Promise.allSettled([...this.accepted]);
      await Promise.all(
        [...this.runtimes.values()].map((v) => v.documents.close()),
      );
      for (const vault of this.runtimes.values()) vault.tree.dispose();
      await this.persistence;
      this.disposed = true;
      this.resourceSetters.clear();
      this.listeners.clear();
    })().catch((error) => {
      this.closePromise = undefined;
      this.resumeAfterCloseFailure();
      this.error = `无法关闭工作区：${message(error)}`;
      this.notify();
      throw error;
    }));
  }
}
function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
async function directoryDisplayPath(
  handle: FileSystemDirectoryHandle,
  scope?: FileSystemDirectoryHandle,
) {
  if (!scope) return;
  try {
    const relative = await scope.resolve(handle);
    if (relative !== null) return [scope.name, ...relative].join("/");
  } catch {
    // Optional resource capabilities must not prevent loading the Vault connection.
  }
}

/** Validate before publishing any stored entries, so a malformed file stays owned by storage. */
function readConnections(
  text: string | null,
  native: boolean,
): VaultConnection[] {
  if (!text) return [];
  const document = JSON.parse(text);
  if (document.version !== 2 || !Array.isArray(document.connections))
    throw new Error("连接记录格式无效。");
  const connections: VaultConnection[] = [];
  const seen = new Set<string>();
  for (const connection of document.connections) {
    let parsed: VaultConnection;
    if (native && connection.kind === "directory") {
      if (
        typeof connection.id !== "string" ||
        !connection.id.startsWith("directory:") ||
        typeof connection.path !== "string" ||
        !connection.path ||
        typeof connection.name !== "string"
      )
        throw new Error("连接记录格式无效。");
      parsed = {
        id: connection.id,
        kind: "directory",
        name: connection.name,
        directoryPath: connection.path,
      };
    } else {
      if (
        typeof connection.id !== "string" ||
        !/^remote:[0-9a-f-]{36}$/.test(connection.id) ||
        typeof connection.url !== "string" ||
        typeof connection.name !== "string"
      )
        throw new Error("连接记录格式无效。");
      parsed = {
        id: connection.id,
        kind: "remote",
        name: connection.name,
        url: normalizeVaultUrl(connection.url),
      };
    }
    if (!seen.has(parsed.id)) {
      seen.add(parsed.id);
      connections.push(parsed);
    }
  }
  return connections;
}
