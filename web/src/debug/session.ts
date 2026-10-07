import { normalizeVaultUrl } from "../lib/vault/http";
import { ReplicaCore } from "./replica";
import type { CoreMutation } from "../lib/editor/core";
import type {
  InstanceIdentity,
  SyncPacket,
  TextSnapshot,
  UndoState,
  Version,
} from "../lib/editor/contract";

export interface DebugDocument {
  id: string;
  path: string;
  snapshot: TextSnapshot;
  writerId: string;
  undo: UndoState;
  dirty: boolean;
  savedContent: string;
  savedVersion: Version | null;
  durableVersion: Version | null;
  persistenceError: string | null;
  conflict: boolean;
  deleted: boolean;
}
interface Descriptor {
  protocol: string;
  version: number;
  readOnly: boolean;
  vaultIdentity: { id: string; historyId: string };
  capabilities: { documentEditing: boolean; persistentHistory: boolean };
}
interface Replica {
  name: string;
  identity: InstanceIdentity;
  core: ReplicaCore;
  document: DebugDocument;
  text: string;
  paused: boolean;
  edits: number;
  lastError: string | null;
  acknowledged: Version | null;
}
export type ReplicaView = Omit<Replica, "core">;
export interface DebugState {
  connected: boolean;
  url: string;
  readOnly: boolean;
  documents: DebugDocument[];
  host: DebugDocument | null;
  replicas: ReplicaView[];
  busy: boolean;
  automatic: boolean;
  error: string | null;
  log: {
    id: number;
    time: string;
    actor: string;
    action: string;
    detail: string;
    failed: boolean;
  }[];
}
export function sameVersion(a: Version, b: Version) {
  return (
    a.identity.document_id === b.identity.document_id &&
    a.identity.history_id === b.identity.history_id &&
    Object.keys(a.clocks).length === Object.keys(b.clocks).length &&
    Object.entries(a.clocks).every(
      ([writer, count]) => b.clocks[writer] === count,
    )
  );
}
export function hasUnsent(local: Version, host: Version) {
  return Object.entries(local.clocks).some(
    ([writer, count]) => count > (host.clocks[writer] ?? 0),
  );
}
/** Reference pull/push transport; no hidden saves or production session protocol. */
export class DebugSession {
  private url = "";
  private descriptor: Descriptor | null = null;
  private documents: DebugDocument[] = [];
  private host: DebugDocument | null = null;
  private replicas: Replica[] = [];
  private busy = 0;
  private automatic = false;
  private error: string | null = null;
  private log: DebugState["log"] = [];
  private listeners = new Set<(state: DebugState) => void>();
  private queue: Promise<unknown> = Promise.resolve();
  private timer?: ReturnType<typeof setInterval>;
  private logId = 0;
  private disposed = false;
  private abort = new AbortController();
  snapshot(): DebugState {
    return {
      connected: !!this.descriptor,
      url: this.url,
      readOnly: this.descriptor?.readOnly ?? false,
      documents: [...this.documents],
      host: this.host,
      replicas: this.replicas.map(({ core: _core, ...replica }) => ({
        ...replica,
      })),
      busy: this.busy > 0,
      automatic: this.automatic,
      error: this.error,
      log: [...this.log],
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
  private record(
    actor: string,
    action: string,
    detail: string,
    failed = false,
  ) {
    this.log = [
      {
        id: ++this.logId,
        time: new Date().toLocaleTimeString(),
        actor,
        action,
        detail,
        failed,
      },
      ...this.log,
    ].slice(0, 100);
    this.notify();
  }
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(() => {
      if (this.disposed) throw new Error("调试会话已关闭");
      return task();
    });
    this.queue = result.catch(() => {});
    return result;
  }
  private async operation(
    actor: string,
    action: string,
    task: () => Promise<void>,
  ) {
    this.busy++;
    this.error = null;
    this.notify();
    try {
      await this.enqueue(task);
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
      this.record(actor, action, this.error, true);
    } finally {
      this.busy--;
      this.notify();
    }
  }
  private async http<T>(path: string, body?: unknown): Promise<T> {
    const response = await fetch(this.url + "/api/v1" + path, {
      method: body === undefined ? "GET" : "POST",
      cache: "no-store",
      referrerPolicy: "no-referrer",
      signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(15000)]),
      headers: {
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const value = await response.json();
    if (!response.ok)
      throw new Error(
        `${value.code ?? response.status}: ${value.message ?? response.statusText}`,
      );
    return value as T;
  }
  connect(value: string) {
    return this.operation("host", "连接", async () => {
      if (this.descriptor) throw new Error("请先结束当前调试会话");
      this.url = normalizeVaultUrl(value);
      const descriptor = await this.http<Descriptor>("");
      if (
        descriptor.protocol !== "celestite-vault" ||
        descriptor.version !== 1 ||
        !descriptor.capabilities?.documentEditing ||
        !descriptor.vaultIdentity?.id ||
        !descriptor.vaultIdentity.historyId
      )
        throw new Error("Server 未提供兼容的文档 CRDT API");
      const documents = await this.http<DebugDocument[]>("/documents");
      this.documents = documents.filter((document) => !document.deleted);
      this.descriptor = descriptor;
      this.record(
        "host",
        "连接",
        `发现 ${this.documents.length} 个文本；历史${descriptor.capabilities.persistentHistory ? "持久化" : "仅驻留内存"}`,
      );
    });
  }
  private route() {
    if (!this.host) throw new Error("请先打开调试文档");
    return `/documents/${encodeURIComponent(this.host.id)}`;
  }
  private replica(name: string) {
    const replica = this.replicas.find((item) => item.name === name);
    if (!replica) throw new Error("调试实例不存在");
    return replica;
  }
  private releaseReplicas() {
    for (const replica of this.replicas) replica.core.dispose();
    this.replicas = [];
  }
  open(path: string) {
    return this.operation("host", "打开", async () => {
      const document = await this.http<DebugDocument>("/documents/open", {
        path,
      });
      this.setAutomatic(false);
      this.releaseReplicas();
      this.host = document;
      const packet = await this.http<SyncPacket>(this.route() + "/snapshot");
      await this.add(packet);
      await this.add(packet);
      await this.refreshHost();
      this.record("host", "打开", `${document.path} · ${document.id}`);
    });
  }
  private async add(packet: SyncPacket) {
    if (!this.descriptor || !this.host) throw new Error("请先打开调试文档");
    const name = String.fromCharCode(65 + this.replicas.length);
    const identity: InstanceIdentity = {
      instanceId: crypto.randomUUID(),
      vault: {
        vaultId: this.descriptor.vaultIdentity.id,
        historyId: this.descriptor.vaultIdentity.historyId,
      },
    };
    const core = new ReplicaCore(identity);
    try {
      const document = await core.call<DebugDocument>("join", {
        path: this.host.path,
        packet,
      });
      if (this.disposed) throw new Error("调试会话已关闭");
      this.replicas.push({
        name,
        identity,
        core,
        document,
        text: document.snapshot.text,
        paused: false,
        edits: 0,
        lastError: null,
        acknowledged: null,
      });
      this.record(name, "加入", `writer ${document.writerId} · 内存 core`);
    } catch (error) {
      core.dispose();
      throw error;
    }
  }
  addReplica() {
    return this.operation("client", "加入", async () => {
      if (this.replicas.length >= 6) throw new Error("调试页最多运行 6 个实例");
      await this.add(await this.http<SyncPacket>(this.route() + "/snapshot"));
      await this.refreshHost();
    });
  }
  edit(name: string, text: string) {
    const replica = this.replica(name);
    replica.text = text;
    replica.edits++;
    this.notify();
    void this.enqueue(async () => {
      const current = replica.document.snapshot.version;
      const result = await replica.core.apply(replica.document.id, {
        kind: "edit",
        base: current,
        input: { kind: "text", text },
        origin: "input.replace",
        undo: { positions: [] },
      });
      replica.document = result.document;
      replica.lastError = null;
    })
      .catch((error) => {
        replica.lastError =
          error instanceof Error ? error.message : String(error);
        this.record(name, "编辑失败", replica.lastError, true);
      })
      .finally(() => {
        replica.edits--;
        this.notify();
      });
  }
  private async refreshHost() {
    this.host = await this.http<DebugDocument>(this.route());
    this.notify();
  }
  refresh() {
    return this.operation("host", "刷新", () => this.refreshHost());
  }
  private ensureWritable() {
    if (this.descriptor?.readOnly) throw new Error("这个 Vault 是只读的");
  }
  private async pushReplica(replica: Replica) {
    if (replica.paused) throw new Error(`实例 ${replica.name} 已暂停传输`);
    this.ensureWritable();
    if (replica.lastError) throw new Error("请先修正未被 core 接受的输入");
    await this.refreshHost();
    if (
      !hasUnsent(replica.document.snapshot.version, this.host!.snapshot.version)
    ) {
      replica.acknowledged = this.host!.durableVersion;
      this.record(replica.name, "推送", "host 已包含该实例的全部操作");
      return;
    }
    const packet = await replica.core.call<SyncPacket>("export_updates", {
      id: replica.document.id,
      version: this.host!.snapshot.version,
    });
    const reply = await this.http<CoreMutation>(this.route() + "/apply", {
      kind: "import",
      packet,
      origin: "debug-peer",
    });
    this.host = reply.document;
    replica.acknowledged = reply.document.durableVersion;
    this.record(
      replica.name,
      "推送 → host",
      `${packet.data.length} B · ${reply.update.pending ? "等待因果依赖" : "已合并"} · ${reply.document.durableVersion ? "历史已提交" : "host 历史仅驻留内存"}`,
    );
  }
  private async pullReplica(replica: Replica) {
    if (replica.paused) throw new Error(`实例 ${replica.name} 已暂停传输`);
    await this.refreshHost();
    if (
      sameVersion(
        replica.document.snapshot.version,
        this.host!.snapshot.version,
      )
    ) {
      this.record(replica.name, "拉取", "因果版本一致，无需更新");
      return;
    }
    const packet = await this.http<SyncPacket>(
      this.route() + "/updates",
      replica.document.snapshot.version,
    );
    const reply = await replica.core.apply(replica.document.id, {
      kind: "import",
      packet,
      origin: "debug-peer",
    });
    replica.document = reply.document;
    replica.text = reply.document.snapshot.text;
    this.record(
      replica.name,
      "host → 拉取",
      `${packet.data.length} B · ${reply.update.pending ? "等待因果依赖" : "已合并"}`,
    );
    await this.refreshHost();
  }
  push(name: string) {
    return this.operation(name, "推送", () =>
      this.pushReplica(this.replica(name)),
    );
  }
  pull(name: string) {
    return this.operation(name, "拉取", () =>
      this.pullReplica(this.replica(name)),
    );
  }
  syncAll() {
    return this.operation("all", "同步", async () => {
      for (const replica of this.replicas.filter((item) => !item.paused)) {
        if (!this.descriptor?.readOnly) await this.pushReplica(replica);
      }
      for (const replica of this.replicas.filter((item) => !item.paused))
        await this.pullReplica(replica);
      await this.refreshHost();
    });
  }
  undo(name: string, redo = false) {
    return this.operation(name, redo ? "重做" : "撤销", async () => {
      this.ensureWritable();
      const replica = this.replica(name);
      const result = await replica.core.apply(replica.document.id, {
        kind: redo ? "redo" : "undo",
        base: replica.document.snapshot.version,
        context: { positions: [] },
      });
      replica.document = result.document;
      replica.text = result.document.snapshot.text;
      replica.lastError = null;
      this.record(
        name,
        redo ? "重做" : "撤销",
        "由此实例自己的 writer 产生更新；尚未推送",
      );
    });
  }
  pause(name: string) {
    const replica = this.replica(name);
    replica.paused = !replica.paused;
    this.record(
      name,
      replica.paused ? "暂停传输" : "恢复传输",
      "仅控制调试包交换，内存 core 保留",
    );
  }
  save() {
    return this.operation("host", "保存", async () => {
      this.ensureWritable();
      this.host = await this.http<DebugDocument>(
        this.route() + "/save",
        this.host!.snapshot.version,
      );
      this.record(
        "host",
        "保存",
        "host 正文已写回普通文件；客户端未推送修改不在此次保存内",
      );
    });
  }
  setAutomatic(enabled: boolean) {
    if (this.timer) clearInterval(this.timer);
    this.automatic = enabled;
    if (enabled)
      this.timer = setInterval(() => {
        if (
          !this.busy &&
          this.host &&
          !this.replicas.some((replica) => replica.edits > 0)
        )
          void this.syncAll().then(() => {
            if (this.error) this.setAutomatic(false);
          });
      }, 1000);
    this.notify();
  }
  disconnect() {
    if (this.busy || this.replicas.some((replica) => replica.edits > 0)) return;
    this.setAutomatic(false);
    this.releaseReplicas();
    this.descriptor = null;
    this.host = null;
    this.documents = [];
    this.error = null;
    this.record("all", "结束会话", "调试内存实例已释放");
  }
  dispose() {
    this.abort.abort();
    this.disposed = true;
    this.setAutomatic(false);
    this.releaseReplicas();
    this.listeners.clear();
  }
}
