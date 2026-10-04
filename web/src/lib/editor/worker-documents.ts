import { VaultError } from "../vault/errors";
import { vaultPath, type VaultPath } from "../vault/path";
import type {
  Entry,
  EntryStat,
  VaultBackend,
  WriteFileOptions,
} from "../vault/types";
import type { DocumentsSnapshot } from "./documents";
import { EditorClient } from "./rpc";
import type {
  EditorDocument,
  InstanceIdentity,
  SelectionContext,
  ServiceDocument,
  ViewEdit,
} from "./contract";

interface ViewRecord extends EditorDocument {
  savedContent: string;
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
  private records = new Map<string, ViewRecord>();
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
  ) {
    this.unsubscribe = client.subscribe((event) => {
      this.merge(event.document);
      this.notify();
    });
    this.unsubscribeFailure = client.onFailure((error) => {
      this.openError = error.message;
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
      watch: async () => () => {},
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
      activeId: this.activeId,
      activation: this.activation,
      loadingPath: this.loadingPath,
      openError: this.openError,
      conflictPrompt: this.conflictPrompt,
      conflictResolving: this.conflictResolving,
      conflictError: this.conflictError,
      documents: [...this.records.values()].map((record) => {
        const { inputs, savedContent, blocked, ...document } = record;
        return {
          ...document,
          locked: document.locked || blocked,
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
  private merge(document: ServiceDocument, replace = false) {
    const record = this.records.get(document.id);
    if (!record) return;
    const { content, savedContent, ...metadata } = document;
    Object.assign(record, metadata);
    if (savedContent !== undefined) record.savedContent = savedContent;
    if (content !== undefined && (replace || record.inputs.length === 0))
      record.content = content;
    if (document.core?.historyError) record.error = document.core.historyError;
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
  activate(id: string) {
    if (this.closing || !this.records.has(id)) return;
    this.openRequest++;
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
      this.closing
    )
      return false;
    record.content = input.content;
    record.inputs.push(input);
    this.notify();
    void this.enqueue(() => this.performEdit(record, input)).catch((error) => {
      record.blocked = true;
      record.error = `编辑尚未确认，输入已保留。${error instanceof Error ? error.message : String(error)}`;
      this.notify();
    });
    return true;
  }
  private async performEdit(
    record: ViewRecord,
    input: ViewEdit,
  ): Promise<boolean> {
    if (!record.inputs.includes(input)) return true;
    if (record.core?.historyError || record.blocked) return false;
    if (record.inputs[0] !== input)
      throw new VaultError("IO", "待确认输入顺序不连续。");
    const result = await this.client.request("edit", {
      id: record.id,
      version: record.core!.version,
      edits: input.edits,
      context: input.before,
      userEvent: input.userEvent,
    });
    record.inputs.shift();
    this.merge(result.document);
    this.notify();
    return !record.core?.historyError;
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
      this.closing
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
    if (!record || record.readOnlyReason) return false;
    return this.enqueue(() => this.saveRecord(record));
  }
  private async saveRecord(record: ViewRecord) {
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
    const record = this.records.get(id);
    if (!record || this.closing) return false;
    record.locked = true;
    this.notify();
    try {
      return await this.enqueue(async () => {
        if (!record.readOnlyReason && !(await this.saveRecord(record)))
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
  async resolveConflict(action: "overwrite" | "discard" | "cancel") {
    const prompt = this.conflictPrompt;
    if (!prompt || this.conflictResolving || this.closing) return false;
    if (action === "cancel") {
      this.conflictPrompt = null;
      this.notify();
      return false;
    }
    const record = this.records.get(prompt.id);
    if (!record) return false;
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
      if (
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
  const worker = new Worker(new URL("./worker.ts", import.meta.url), {
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
