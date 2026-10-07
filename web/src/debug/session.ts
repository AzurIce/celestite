import { openHttpVault } from "../lib/vault/http";
import { vaultPath } from "../lib/vault/path";
import type { Entry } from "../lib/vault/types";
import { openRemoteEditor } from "../lib/editor/client/documents";
import { minimalChange } from "../lib/editor/view-changes";
import type {
  DocumentSnapshot,
  EditorDocuments,
  InstanceIdentity,
} from "../lib/editor/contract";

interface Replica {
  name: string;
  identity: InstanceIdentity;
  documents: EditorDocuments;
  detach: () => void;
  document: DocumentSnapshot;
  online: boolean;
  unconfirmed: boolean;
  error: string | null;
}
export type ReplicaView = Omit<Replica, "documents" | "detach">;
export interface DebugState {
  connected: boolean;
  readOnly: boolean;
  files: Entry[];
  path: string;
  replicas: ReplicaView[];
  busy: boolean;
  error: string | null;
}
/** The inspector uses exactly the production Worker, core and sync session. */
export class DebugSession {
  private url = "";
  private readOnly = false;
  private files: Entry[] = [];
  private path = "";
  private replicas: Replica[] = [];
  private busy = false;
  private error: string | null = null;
  private disposed = false;
  private listeners = new Set<(state: DebugState) => void>();
  snapshot(): DebugState {
    return {
      connected: !!this.url,
      readOnly: this.readOnly,
      files: this.files,
      path: this.path,
      replicas: this.replicas.map(
        ({ documents, detach, ...replica }) => replica,
      ),
      busy: this.busy,
      error: this.error,
    };
  }
  subscribe(listener: (state: DebugState) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private notify() {
    if (!this.disposed)
      for (const listener of this.listeners) listener(this.snapshot());
  }
  private async operation(task: () => Promise<void>) {
    if (this.busy || this.disposed) return;
    this.busy = true;
    this.error = null;
    this.notify();
    try {
      await task();
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    } finally {
      this.busy = false;
      this.notify();
    }
  }
  async connect(url: string) {
    await this.operation(async () => {
      const { backend, descriptor } = await openHttpVault(url);
      try {
        const files: Entry[] = [];
        const walk = async (path: string) => {
          for await (const entry of backend.readDir(vaultPath(path))) {
            if (entry.kind === "directory") await walk(entry.path);
            else files.push(entry);
          }
        };
        await walk("");
        this.files = files;
        this.readOnly = descriptor.readOnly;
        this.url = backend.url;
      } finally {
        await backend.close();
      }
    });
  }
  async open(path: string) {
    await this.operation(async () => {
      await this.release();
      this.path = path;
      await this.add();
      await this.add();
    });
  }
  async addReplica() {
    await this.operation(() => this.add());
  }
  private async add() {
    if (!this.path || this.replicas.length >= 6) return;
    const { backend } = await openHttpVault(this.url);
    const { identity, documents } = await openRemoteEditor(this.url, backend);
    if (!(await documents.open(vaultPath(this.path)))) {
      const error = documents.snapshot().openError;
      await documents.close();
      throw new Error(error ?? "无法打开调试文档。");
    }
    const snapshot = documents.snapshot();
    const replica: Replica = {
      name: String.fromCharCode(65 + this.replicas.length),
      identity,
      documents,
      detach: () => {},
      document: snapshot.documents[0],
      online: true,
      unconfirmed: !!snapshot.connection?.unconfirmed,
      error: null,
    };
    replica.detach = documents.subscribe((state) => {
      const document = state.documents.find(
        (document) => document.id === replica.document.id,
      );
      if (document) replica.document = document;
      replica.online = state.connection?.status === "online";
      replica.unconfirmed = !!state.connection?.unconfirmed;
      replica.error = state.connection?.error ?? state.openError;
      this.notify();
    });
    this.replicas.push(replica);
    this.notify();
  }
  edit(name: string, text: string) {
    const replica = this.replicas.find((replica) => replica.name === name);
    if (!replica) return;
    const previous = replica.document.content;
    const selection = { ranges: [{ anchor: 0, head: 0 }], mainIndex: 0 };
    replica.documents.edit(replica.document.id, {
      edits: [minimalChange(previous, text)],
      content: text,
      before: selection,
      after: selection,
      userEvent: "input.replace",
    });
  }
  async undo(name: string, redo = false) {
    const replica = this.replicas.find((replica) => replica.name === name);
    if (replica)
      await this.operation(async () => {
        await replica.documents.undo(
          replica.document.id,
          { ranges: [{ anchor: 0, head: 0 }], mainIndex: 0 },
          redo,
        );
      });
  }
  async save(name: string) {
    const replica = this.replicas.find((replica) => replica.name === name);
    if (replica)
      await this.operation(async () => {
        if (!(await replica.documents.save(replica.document.id)))
          throw new Error(
            replica.documents.snapshot().documents[0]?.error ?? "保存失败。",
          );
      });
  }
  async reconnect(name: string) {
    const replica = this.replicas.find((replica) => replica.name === name);
    if (replica)
      await this.operation(async () => {
        await replica.documents.reconnect?.();
      });
  }
  async disconnect() {
    await this.operation(async () => {
      await this.release();
      this.url = "";
      this.files = [];
      this.path = "";
    });
  }
  private async release() {
    // A failed close leaves the replica available for copying/recovery.
    for (const replica of [...this.replicas]) {
      await replica.documents.close();
      replica.detach();
      this.replicas = this.replicas.filter((current) => current !== replica);
    }
  }
  dispose() {
    this.disposed = true;
    this.listeners.clear();
    void this.release().catch(() => {});
  }
}
