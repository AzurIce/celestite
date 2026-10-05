import { VaultError } from "../../vault/errors";
import { vaultPath, type VaultPath } from "../../vault/path";
import type {
  Entry,
  EntryStat,
  VaultBackend,
  WriteFileOptions,
} from "../../vault/types";
import type { DocumentsSnapshot } from "../documents";
import { EditorClient } from "../rpc";
import { rebaseInputs } from "../view-changes";
import type { DocumentPreviews, PreviewState } from "../preview/contract";
import type {
  ConnectionState,
  EditorDocument,
  InstanceIdentity,
  SelectionContext,
  ServiceDocument,
  ViewEdit,
} from "../contract";

interface ViewRecord extends EditorDocument {
  savedContent: string;
  acceptedContent: string;
  inputs: ViewEdit[];
  blocked: boolean;
}
function within(path: VaultPath, parent: VaultPath) {
  return path === parent || parent === "" || path.startsWith(parent + "/");
}
export function applyEdits(
  text: string,
  edits: readonly { from: number; to: number; insert: string }[],
) {
  for (let i = edits.length - 1; i >= 0; i--) {
    const edit = edits[i];
    text = text.slice(0, edit.from) + edit.insert + text.slice(edit.to);
  }
  return text;
}
/** Main-thread view controller. Accepted history/undo/IO live only in the host. */
export class WorkerDocuments {
  readonly previews: DocumentPreviews = {
    subscribe: (id, listener) => this.subscribePreview(id, listener),
    retry: async (id) => {
      await this.client.request("preview_retry", { id });
    },
    link: (id, taskId, target) =>
      this.client.request("preview_link", { id, taskId, target }),
    assets: (id, taskId) =>
      this.client.request("preview_assets", { id, taskId }),
  };
  reconnect?: (discardUnconfirmed?: boolean) => Promise<void>;
  private connection?: ConnectionState;
  private replacingSession = false;
  private records = new Map<string, ViewRecord>();
  private treeListeners = new Set<Parameters<VaultBackend["watch"]>[0]>();
  private listeners = new Set<(state: DocumentsSnapshot) => void>();
  private queue: Promise<unknown> = Promise.resolve();
  private activeId: string | null = null;
  private activation = 0;
  private loadingPath: VaultPath | null = null;
  private openError: string | null = null;
  private conflictPrompt: DocumentsSnapshot["conflictPrompt"] = null;
  private conflictResolving = false;
  private conflictError: string | null = null;
  private openRequest = 0;
  private undoRequests = new Map<string, number>();
  private closing = false;
  private closePromise?: Promise<void>;
  private unsubscribe: () => void;
  private unsubscribeFailure: () => void;
  readonly treeBackend: VaultBackend;
  constructor(
    private client: EditorClient,
    private terminate: () => void,
    watch: VaultBackend["watch"] = async () => () => {},
    private readonly remote = false,
  ) {
    if (remote) this.connection = { status: "online", error: null };
    this.unsubscribe = client.subscribe((event) => {
      if (event.kind === "connection") {
        if (!this.replacingSession || event.connection.status !== "online")
          this.connection = event.connection;
        this.notify();
        return;
      }
      if (event.kind === "tree") {
        if (this.connection && this.connection.status !== "online") return;
        for (const listener of this.treeListeners)
          listener({ paths: [vaultPath("")], recursive: true });
        return;
      }
      if (!this.replacingSession) this.merge(event.document);
      this.notify();
    });
    this.unsubscribeFailure = client.onFailure((error) => {
      this.openError = error.message;
      if (this.connection)
        this.connection = { status: "offline", error: error.message };
      for (const record of this.records.values()) {
        record.blocked = true;
        record.locked = true;
        record.error = error.message;
      }
      this.notify();
    });
    this.treeBackend = {
      readDir: (path) => this.readDir(path),
      stat: (path) => this.file("stat", { path }) as Promise<EntryStat | null>,
      readFile: (path) =>
        this.file("readFile", { path }) as Promise<Uint8Array>,
      readFileSnapshot: (path) =>
        this.file("readFileSnapshot", { path }) as Promise<{
          data: Uint8Array;
          revision: string;
        }>,
      writeFile: (path, data, options) =>
        this.file("writeFile", { path, data, options }) as Promise<string>,
      mkdir: (path, options) =>
        this.file("mkdir", { path, options }) as Promise<void>,
      rename: (from, to) => this.file("rename", { from, to }) as Promise<void>,
      remove: (path, options) =>
        this.file("remove", { path, options }) as Promise<void>,
      watch: async (listener) => {
        this.treeListeners.add(listener);
        const detach = await watch(listener);
        return () => {
          this.treeListeners.delete(listener);
          detach();
        };
      },
      close: () => this.close(),
    };
  }
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task);
    this.queue = result.catch(() => {});
    return result;
  }
  snapshot(): DocumentsSnapshot {
    return {
      connection: this.connection
        ? {
            ...this.connection,
            unconfirmed:
              this.connection.unconfirmed ||
              [...this.records.values()].some(
                (record) => record.inputs.length || record.blocked,
              ),
          }
        : undefined,
      activeId: this.activeId,
      activation: this.activation,
      loadingPath: this.loadingPath,
      openError: this.openError,
      conflictPrompt: this.conflictPrompt,
      conflictResolving: this.conflictResolving,
      conflictError: this.conflictError,
      documents: [...this.records.values()].map((record) => {
        const { inputs, savedContent, acceptedContent, blocked, ...document } =
          record;
        return {
          ...document,
          locked: document.locked || blocked,
          readOnlyReason:
            this.connection && this.connection.status !== "online"
              ? "远端连接已断开，请重新连接。"
              : document.readOnlyReason,
          dirty: document.content !== savedContent,
          pending: inputs.length,
        };
      }),
    };
  }
  subscribe(listener: (state: DocumentsSnapshot) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private notify() {
    for (const listener of this.listeners) listener(this.snapshot());
  }
  private subscribePreview(
    id: string,
    listener: (state: PreviewState | null) => void,
  ) {
    let active = true;
    let seenEvent = false;
    let subscriptionId: string | undefined;
    const detach = this.client.subscribePreview((event) => {
      if (event.documentId === id && active) {
        seenEvent = true;
        listener(event.state);
      }
    });
    const release = () => {
      if (subscriptionId)
        void this.client
          .request("preview_unsubscribe", { subscriptionId })
          .catch(() => {});
    };
    void this.client
      .request("preview_subscribe", { id })
      .then((subscription) => {
        subscriptionId = subscription.subscriptionId;
        if (!active) release();
        else if (!seenEvent) listener(subscription.state);
      })
      .catch(() => {
        if (active) listener(null);
      });
    return () => {
      active = false;
      detach();
      release();
    };
  }
  private merge(document: ServiceDocument, replace = false) {
    const record = this.records.get(document.id);
    if (!record) return;
    const { content, savedContent, change, ...metadata } = document;
    if (change && content !== undefined) {
      if (record.acceptedContent !== change.before) {
        record.blocked = true;
        record.error = "远端投影版本不连续，输入仍保留。请复制正文后重新连接。";
        record.inputFailure = { outcome: "projection", message: record.error };
        return;
      }
      const beforeProjection = record.content;
      const rebased = rebaseInputs(change.before, change.edits, record.inputs);
      record.acceptedContent = content;
      record.content = rebased.content;
      record.remoteChange = { before: beforeProjection, edits: rebased.edits };
    } else if (
      content !== undefined &&
      (replace || record.inputs.length === 0)
    ) {
      record.content = content;
      record.acceptedContent = content;
    }
    Object.assign(record, metadata);
    if (savedContent !== undefined) record.savedContent = savedContent;
    if (document.core?.historyError) record.error = document.core.historyError;
  }
  async authorize(token: string, discardUnconfirmed = false) {
    if (this.replacingSession) throw new VaultError("Busy", "正在重新连接。");
    this.replacingSession = true;
    this.connection = {
      ...this.connection,
      status: "reconnecting",
      error: null,
    };
    this.notify();
    try {
      // Let in-flight RPCs settle first; their outcome decides whether input
      // needs explicit discard. Queued edits see reconnecting and do not run.
      await this.queue;
      if (!discardUnconfirmed && this.snapshot().connection?.unconfirmed)
        throw new VaultError(
          "Conflict",
          "存在未确认输入。重新连接将采用远端历史，请先导出正文或确认丢弃。",
        );
      const documents = await this.client.request("authorize", { token });
      for (const document of documents) {
        const record = this.records.get(document.id);
        if (!record) continue;
        record.inputs = [];
        record.blocked = false;
        record.locked = false;
        delete record.remoteChange;
        delete record.restoredSelection;
        delete record.inputFailure;
        this.merge(document, true);
        record.reloadVersion++;
      }
      this.openError = null;
      this.connection = { status: "online", error: null };
      this.conflictPrompt = null;
      for (const listener of this.treeListeners)
        listener({ paths: [vaultPath("")], recursive: true });
    } catch (error) {
      this.connection = {
        ...this.connection,
        status: "offline",
        error: error instanceof Error ? error.message : String(error),
      };
      throw error;
    } finally {
      this.replacingSession = false;
      this.notify();
    }
  }

  has(id: string) {
    return this.records.has(id);
  }
  hasUnsaved() {
    return [...this.records.values()].some(
      (record) =>
        record.inputs.length ||
        record.saving ||
        record.content !== record.savedContent ||
        record.core?.historyError,
    );
  }
  private online() {
    return !this.connection || this.connection.status === "online";
  }
  private requireOnline() {
    if (!this.online())
      throw new VaultError("Closed", "远端连接已断开，请重新连接后操作。");
  }
  activate(id: string) {
    if (!this.online() || this.closing || !this.records.has(id)) return;
    this.openRequest++;
    this.loadingPath = null;
    this.openError = null;
    this.activeId = id;
    this.activation++;
    this.notify();
  }
  async open(path: VaultPath): Promise<boolean> {
    if (!this.online() || this.closing) return false;
    const existing = [...this.records.values()].find(
      (record) => record.path === path && !record.deleted,
    );
    if (existing) {
      this.activate(existing.id);
      return true;
    }
    const request = ++this.openRequest;
    this.loadingPath = path;
    this.openError = null;
    this.activation++;
    this.notify();
    return this.enqueue(async () => {
      try {
        if (request !== this.openRequest || this.closing) return false;
        const document = await this.client.request("open", {
          path,
        });
        if (request !== this.openRequest || this.closing) return false;
        this.records.set(document.id, {
          ...document,
          content: document.content ?? "",
          acceptedContent: document.content ?? "",
          savedContent: document.savedContent ?? "",
          dirty: false,
          locked: false,
          reloadVersion: 0,
          inputs: [],
          blocked: false,
        });
        this.activeId = document.id;
        return true;
      } catch (error) {
        if (request === this.openRequest)
          this.openError =
            error instanceof Error ? error.message : String(error);
        return false;
      } finally {
        if (request === this.openRequest) {
          this.loadingPath = null;
          this.notify();
        }
      }
    });
  }
  composition(id: string, active: boolean) {
    if (!this.online()) return;
    const send = () => this.client.request("composition", { id, active });
    // Start precedes the first IME transaction; end follows all of its queued
    // inputs, so held remote updates cannot split a composition.
    void (active ? send() : this.enqueue(send)).catch(() => {});
  }
  /** Full-text writes are deliberately unavailable on the worker edit path. */
  update(_id: string, _content: string) {
    return false;
  }
  edit(id: string, input: ViewEdit): boolean {
    const record = this.records.get(id);
    if (
      !record?.core ||
      record.locked ||
      record.readOnlyReason ||
      record.blocked ||
      record.core.historyError ||
      this.closing ||
      (this.connection && this.connection.status !== "online")
    )
      return false;
    record.content = input.content;
    record.inputs.push(input);
    this.notify();
    void this.enqueue(() => this.performEdit(record, input)).catch((error) => {
      record.blocked = true;
      record.error = `编辑尚未确认，输入已保留。${error instanceof Error ? error.message : String(error)}`;
      record.inputFailure = { outcome: "unknown", message: record.error };
      this.notify();
    });
    return true;
  }
  private async performEdit(
    record: ViewRecord,
    input: ViewEdit,
  ): Promise<boolean> {
    if (!record.inputs.includes(input)) return true;
    if (
      record.core?.historyError ||
      record.blocked ||
      (this.connection && this.connection.status !== "online")
    )
      return false;
    if (record.inputs[0] !== input)
      throw new VaultError("IO", "待确认输入顺序不连续。");
    const result = await this.client.request("edit", {
      id: record.id,
      version: record.core!.version,
      edits: input.edits,
      context: input.before,
      userEvent: input.userEvent,
    });
    if (result.rejection) {
      record.blocked = true;
      record.error = result.rejection.message;
      record.inputFailure = {
        outcome: "rejected",
        message: result.rejection.message,
      };
      this.notify();
      return false;
    }
    record.inputs.shift();
    record.acceptedContent = result.document.content ?? input.content;
    this.merge(result.document);
    this.notify();
    return !record.core?.historyError;
  }
  async discardRejectedInput(id: string): Promise<boolean> {
    const record = this.records.get(id);
    if (
      !record ||
      !this.online() ||
      this.closing ||
      record.inputFailure?.outcome !== "rejected"
    )
      return false;
    return this.enqueue(async () => {
      if (!this.online() || record.inputFailure?.outcome !== "rejected")
        return false;
      // Drain older queued requests, then adopt the current accepted history.
      // Later optimistic inputs depend on the rejected one and are withdrawn too.
      const document = await this.client.request("read", { id });
      record.inputs = [];
      record.blocked = false;
      delete record.inputFailure;
      this.merge(document, true);
      record.reloadVersion++;
      this.notify();
      return true;
    });
  }
  private async flushInputs(record: ViewRecord) {
    if (record.blocked) return false;
    if (record.core?.historyError) {
      const document = await this.client.request("retry_history", {
        id: record.id,
      });
      this.merge(document);
      if (record.core?.historyError) return false;
    }
    for (const input of [...record.inputs])
      if (!(await this.performEdit(record, input))) return false;
    return true;
  }
  async undo(
    id: string,
    context: SelectionContext,
    redo = false,
  ): Promise<boolean> {
    const record = this.records.get(id);
    if (
      !record?.core ||
      (record.locked && !this.undoRequests.has(id)) ||
      record.readOnlyReason ||
      this.closing ||
      (this.connection && this.connection.status !== "online")
    )
      return false;
    const queued = this.undoRequests.has(id);
    this.undoRequests.set(id, (this.undoRequests.get(id) ?? 0) + 1);
    record.locked = true;
    this.notify();
    try {
      return await this.enqueue(async () => {
        if (!(await this.flushInputs(record))) return false;
        const result = await this.client.request("undo", {
          id,
          context:
            queued && record.restoredSelection
              ? record.restoredSelection
              : context,
          redo,
          version: record.core!.version,
        });
        record.content = applyEdits(record.content, result.edits);
        this.merge(result.document);
        if (result.restoredSelection)
          record.restoredSelection = {
            ...result.restoredSelection,
            revision: (record.restoredSelection?.revision ?? 0) + 1,
          };
        return true;
      });
    } catch (error) {
      record.error = String(error);
      return false;
    } finally {
      const pending = (this.undoRequests.get(id) ?? 1) - 1;
      if (pending) this.undoRequests.set(id, pending);
      else this.undoRequests.delete(id);
      record.locked = pending > 0;
      this.notify();
    }
  }
  async save(id = this.activeId): Promise<boolean> {
    const record = id ? this.records.get(id) : undefined;
    if (!this.online() || !record || record.readOnlyReason) return false;
    return this.enqueue(() => this.saveRecord(record));
  }
  async retryObservation(id: string): Promise<boolean> {
    const record = this.records.get(id);
    if (!this.online() || !record) return false;
    return this.enqueue(async () => {
      try {
        this.merge(await this.client.request("retry_observation", { id }));
        this.notify();
        return true;
      } catch (error) {
        record.error = String(error);
        this.notify();
        return false;
      }
    });
  }
  private async saveRecord(record: ViewRecord) {
    if (!this.online()) return false;
    try {
      if (!(await this.flushInputs(record))) return false;
      const result = await this.client.request("save", {
        id: record.id,
      });
      this.merge(result);
      this.notify();
      return !result.error && !result.core?.historyError;
    } catch (error) {
      record.error = String(error);
      this.notify();
      return false;
    }
  }
  async saveAll() {
    if (!this.online()) return false;
    if (
      [...this.records.values()].some(
        (record) =>
          record.readOnlyReason && record.content !== record.savedContent,
      )
    )
      return false;
    return (
      await Promise.all(
        [...this.records.values()]
          .filter((record) => !record.readOnlyReason)
          .map((record) => this.save(record.id)),
      )
    ).every(Boolean);
  }
  async requestSave(id = this.activeId) {
    const record = id ? this.records.get(id) : undefined;
    if (!record || this.closing) return false;
    if (await this.save(record.id)) return true;
    this.prompt(record, "save");
    return false;
  }
  private prompt(record: ViewRecord, intent: "save" | "close") {
    if (!record.conflict || this.conflictPrompt) return;
    this.activate(record.id);
    this.conflictPrompt = { id: record.id, intent };
    this.conflictError = null;
    this.notify();
  }
  async closeDocument(id: string) {
    if (!this.online()) return false;
    const record = this.records.get(id);
    if (!record || this.closing) return false;
    if (
      !this.remote &&
      record.readOnlyReason &&
      record.content !== record.savedContent
    )
      return false;
    record.locked = true;
    this.notify();
    try {
      return await this.enqueue(async () => {
        if (
          this.remote
            ? !(await this.flushInputs(record))
            : !record.readOnlyReason && !(await this.saveRecord(record))
        )
          return false;
        this.forget(id);
        return true;
      });
    } finally {
      record.locked = false;
      this.notify();
    }
  }
  async requestCloseDocument(id: string) {
    if (await this.closeDocument(id)) return true;
    const record = this.records.get(id);
    if (record) this.prompt(record, "close");
    return false;
  }
  async resolveConflict(action: "overwrite" | "discard" | "retry" | "cancel") {
    if (!this.online()) return false;
    const prompt = this.conflictPrompt;
    if (!prompt || this.conflictResolving || this.closing) return false;
    if (action === "cancel") {
      this.conflictPrompt = null;
      this.notify();
      return false;
    }
    const record = this.records.get(prompt.id);
    if (!record) return false;
    if (
      record.conflictResolution === "shared"
        ? action !== "retry"
        : action === "retry"
    ) {
      this.conflictError = "当前文档不支持这个冲突处理操作。";
      this.notify();
      return false;
    }
    record.locked = true;
    this.conflictResolving = true;
    this.conflictError = null;
    this.notify();
    try {
      return await this.enqueue(async () => {
        if (!(await this.flushInputs(record))) return false;
        const result = await this.client.request("resolve", {
          id: record.id,
          action,
        });
        this.merge(result, action === "discard");
        if (result.error) {
          this.conflictError = result.error;
          return false;
        }
        if (action === "discard") record.reloadVersion++;
        this.conflictPrompt = null;
        if (prompt.intent === "close") this.forget(record.id);
        return true;
      });
    } catch (error) {
      this.conflictError = String(error);
      return false;
    } finally {
      record.locked = false;
      this.conflictResolving = false;
      this.notify();
    }
  }
  private forget(id: string) {
    this.records.delete(id);
    if (this.activeId === id)
      this.activeId = [...this.records.keys()][this.records.size - 1] ?? null;
    if (this.conflictPrompt?.id === id) this.conflictPrompt = null;
  }
  private async *readDir(path: VaultPath) {
    const entries = (await this.file("readDir", { path })) as Entry[];
    yield* entries;
  }
  private async file(
    method: string,
    params: {
      path?: VaultPath;
      from?: VaultPath;
      to?: VaultPath;
      data?: Uint8Array;
      options?: WriteFileOptions | { recursive?: boolean };
    },
  ) {
    if (this.closing) throw new VaultError("Closed", "Vault is closing");
    this.requireOnline();
    const path = params.path ?? params.from ?? vaultPath("");
    const changes = ["rename", "remove", "writeFile", "readFile"].includes(
      method,
    );
    const affected = [...this.records.values()].filter(
      (record) => changes && within(record.path, path),
    );
    for (const record of affected) record.locked = true;
    if (affected.length) this.notify();
    try {
      return await this.enqueue(async () => {
        this.requireOnline();
        for (const record of affected)
          if (!record.readOnlyReason && !(await this.flushInputs(record)))
            throw new VaultError("IO", "编辑历史尚未提交。", path);
        const result = await this.client.request("file", { method, ...params });
        if (method === "remove")
          for (const record of affected) this.forget(record.id);
        // Worker notifications carry stable IDs and renamed paths; don't derive
        // new identities from paths or recreate buffers here.
        return result;
      });
    } finally {
      for (const record of affected) record.locked = false;
      this.notify();
    }
  }
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.openRequest++;
    return (this.closePromise = (async () => {
      if (this.remote) {
        await this.enqueue(async () => {
          for (const record of this.records.values()) {
            if (
              record.blocked ||
              (record.inputs.length &&
                (!this.online() || !(await this.flushInputs(record))))
            )
              throw new VaultError(
                "IO",
                "未确认的编辑仍保留，连接仍保留。请导出正文并重新连接。",
              );
          }
        });
      } else if (
        !(await this.saveAll()) &&
        [...this.records.values()].some(
          (record) => record.inputs.length || record.core?.historyError,
        )
      )
        throw new VaultError("IO", "未提交的编辑仍保留，不能关闭服务。");
      await this.enqueue(() => this.client.request("close", {}));
      this.unsubscribe();
      this.unsubscribeFailure();
      this.client.dispose();
      this.terminate();
      this.listeners.clear();
    })().catch((error) => {
      this.closing = false;
      this.closePromise = undefined;
      throw error;
    }));
  }
}

export async function openOpfsEditor(): Promise<{
  identity: InstanceIdentity;
  documents: WorkerDocuments;
  backend: VaultBackend;
}> {
  const worker = new Worker(new URL("../opfs/worker.ts", import.meta.url), {
    type: "module",
  });
  const client = new EditorClient(worker);
  const error = () =>
    client.fail(
      new VaultError("IO", "编辑 Worker 已停止，尚未确认的输入仍保留。"),
    );
  worker.addEventListener("error", error);
  worker.addEventListener("messageerror", error);
  try {
    const identity = await client.ready;
    const documents = new WorkerDocuments(client, () => worker.terminate());
    return { identity, documents, backend: documents.treeBackend };
  } catch (error) {
    client.dispose();
    worker.terminate();
    throw error;
  }
}

export async function openRemoteEditor(
  url: string,
  token: string,
  backend: VaultBackend,
): Promise<{
  identity: InstanceIdentity;
  documents: import("../contract").EditorDocuments;
  backend: VaultBackend;
  authorize?: (token: string) => Promise<void>;
}> {
  const worker = new Worker(new URL("../remote/worker.ts", import.meta.url), {
    type: "module",
  });
  const client = new EditorClient(worker);
  const error = () =>
    client.fail(
      new VaultError("IO", "远端编辑 Worker 已停止，尚未确认的输入仍保留。"),
    );
  worker.addEventListener("error", error);
  worker.addEventListener("messageerror", error);
  worker.postMessage({ kind: "initialize", url, token });
  try {
    const identity = await client.ready;
    const documents = new WorkerDocuments(
      client,
      () => {
        worker.terminate();
        void backend.close();
      },
      undefined,
      true,
    );
    let currentToken = token;
    documents.reconnect = async (discardUnconfirmed = false) => {
      await documents.authorize(currentToken, discardUnconfirmed);
    };
    return {
      identity,
      documents,
      backend: documents.treeBackend,
      authorize: async (token) => {
        await documents.authorize(token);
        currentToken = token;
        (backend as import("../../vault/http").HttpVaultBackend).authorize(
          token,
        );
      },
    };
  } catch (error) {
    client.dispose();
    worker.terminate();
    await backend.close();
    throw error;
  }
}
