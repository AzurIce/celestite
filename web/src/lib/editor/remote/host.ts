import { VaultError } from "../../vault/errors";
import { vaultPath, type VaultPath } from "../../vault/path";
import type { HttpVaultBackend, RemoteVaultDescriptor } from "../../vault/http";
import { EditorHost } from "../runtime/host";
import type { CoreDocument, CoreMutation, CorePort } from "../core";
import { decodeError } from "../rpc";
import type {
  ServiceDocument,
  HostDocument,
  CollaborationSnapshot,
  VersionedSelection,
  PresenceSelection,
  ServiceEvent,
  SyncPacket,
} from "../contract";
import { RemoteTransport, type RemoteReceipt } from "./transport";
import { SyncSession } from "./session";
import { anchorPositions } from "../presence";

/** Private online replica: core owns history/undo; the transport carries
 * committed updates. Host file saves remain explicit. */
export class RemoteEditorHost extends EditorHost {
  private hosts = new Map<string, HostDocument>();
  private subscriptions = new Set<string>();
  private members: CollaborationSnapshot | null = null;
  private views = new Map<
    string,
    {
      viewId: string;
      documentId: string;
      focused: boolean;
      selection: VersionedSelection | null;
    }
  >();
  private sendingViews = new Set<string>();
  private sync?: SyncSession;
  private unsupported = new Map<string, ServiceDocument>();
  private offline = true;
  private resetting = false;
  private get unconfirmed() {
    return this.sync?.unconfirmed ?? false;
  }
  private transport?: RemoteTransport;
  private composing = new Set<string>();
  private deferred = new Map<string, RemoteReceipt[]>();
  private stopping = false;
  private received = new Map<string, number>();
  private imports = new Map<string, Promise<ServiceDocument>>();
  private inbox = { count: 0, bytes: 0 };
  constructor(
    core: CorePort,
    private http: HttpVaultBackend,
    private descriptor: RemoteVaultDescriptor,
    emit: (event: ServiceEvent) => void,
    private scheduleRemote: (task: () => Promise<unknown>) => void,
  ) {
    super(core, http, emit, scheduleRemote, http.packageResources(descriptor));
  }
  async connect() {
    const identity = this.descriptor.vaultIdentity!;
    const inbox = (this.inbox = { count: 0, bytes: 0 });
    const transport = new RemoteTransport(
      this.http.url,
      identity,
      (receipt) => {
        if (this.transport !== transport) return;
        if (receipt.kind === "members") {
          this.members = receipt.state;
          this.publishMembers(receipt.state);
          return;
        }
        if (receipt.kind === "tree") {
          this.scheduleRemote(async () => {
            if (this.transport === transport && !this.offline) {
              await this.executePreview("preview_invalidate_project", {});
              this.publishTree();
            }
          });
          return;
        }
        inbox.count++;
        inbox.bytes += receipt.packet.data.length;
        if (inbox.count > 256 || inbox.bytes > 32 * 1024 * 1024) {
          this.networkFailure(
            transport,
            new VaultError("IO", "协作接收队列已满，正文仍保留。"),
          );
          return;
        }
        this.scheduleRemote(async () => {
          let held = false;
          try {
            if (
              this.transport !== transport ||
              this.offline ||
              !this.subscriptions.has(receipt.document.id)
            )
              return;
            if (this.composing.has(receipt.document.id)) {
              const pending = this.deferred.get(receipt.document.id) ?? [];
              pending.push(receipt);
              this.deferred.set(receipt.document.id, pending);
              held = true;
              return;
            }
            await this.receive(receipt);
          } catch (error) {
            this.networkFailure(transport, error);
          } finally {
            if (!held) {
              inbox.count--;
              inbox.bytes -= receipt.packet.data.length;
            }
          }
        });
      },
      (error) => this.networkFailure(transport, error),
    );
    this.transport = transport;
    this.sync = new SyncSession(
      (update) => transport.request("updates", { ...update }),
      (unconfirmed) => {
        if (this.transport === transport && !this.offline)
          this.publishConnection({
            status: "online",
            error: null,
            unconfirmed,
          });
      },
      (error) => this.networkFailure(transport, error),
    );
    try {
      await transport.ready;
      const receipts: RemoteReceipt[] = [];
      for (const id of this.subscriptions)
        receipts.push(await transport.request<RemoteReceipt>("open", { id }));
      const hosts = new Map<string, HostDocument>();
      const documents = new Map<
        string,
        { packets: SyncPacket[]; writerId: string }
      >();
      const received = new Map<string, number>();
      for (const receipt of receipts) {
        const id = receipt.document.id;
        const prior = hosts.get(id);
        if (receipt.document.savedContent === undefined && !prior)
          throw new VaultError("IO", "远端缺少初始磁盘元数据。");
        const next = documents.get(id) ?? {
          packets: [],
          writerId: receipt.writerId,
        };
        if (
          next.writerId !== receipt.writerId ||
          receipt.sequence <= (received.get(id) ?? -1)
        )
          throw new VaultError("IO", "初始协作会话不连续。");
        next.packets.push(receipt.packet);
        documents.set(id, next);
        hosts.set(id, {
          ...receipt.document,
          savedContent: receipt.document.savedContent ?? prior!.savedContent,
        });
        received.set(id, receipt.sequence);
      }
      const states = await this.execute<CoreDocument[]>("replica_session", {
        documents: [...documents].map(([id, document]) => ({
          ...document,
          state: this.replicaState(hosts.get(id)!),
        })),
      });
      // Publish the new session only after every history and the final catalogue
      // have been accepted. A failed handshake leaves old buffers and undo intact.
      this.hosts = hosts;
      for (const host of hosts.values())
        this.sync.acknowledge(host.id, host.version);
      this.received = received;
      this.clearPatches();
      this.composing.clear();
      this.deferred.clear();
      for (const view of this.views.values())
        if (this.subscriptions.has(view.documentId)) {
          view.selection = null;
          await transport.request("set_view", { ...view });
        }
      this.offline = false;
      return states.map((state) => this.document(state));
    } catch (error) {
      transport.close();
      throw error;
    }
  }

  override async composition(id: string, active: boolean) {
    if (active) this.composing.add(id);
    else {
      this.composing.delete(id);
      const deferred = this.deferred.get(id) ?? [];
      this.deferred.delete(id);
      if (!this.offline)
        for (const receipt of deferred) {
          try {
            await this.receive(receipt);
          } finally {
            this.inbox.count--;
            this.inbox.bytes -= receipt.packet.data.length;
          }
        }
    }
  }
  private requireOnline() {
    if (this.offline || !this.transport)
      throw new VaultError("Closed", "远端连接已中断，编辑正文仍保留。");
  }
  protected override publish(
    raw: CoreDocument,
    content = false,
    change?: ServiceDocument["change"],
  ) {
    if (!this.resetting)
      super.publish({ ...raw, autosaveDelay: null }, content, change, true);
  }
  protected override document(
    raw: CoreDocument,
    content = true,
  ): ServiceDocument {
    return {
      ...super.document(raw, content),
      conflictResolution: "shared",
      readOnlyReason: this.offline
        ? "远端连接中断，正文已保留；请重新连接后继续编辑。"
        : raw.deleted
          ? "文件已被删除，正文仍可复制。"
          : this.descriptor.readOnly
            ? "当前 Vault 只读。"
            : null,
    };
  }
  private replicaState(
    host: HostDocument,
    error = host.error,
    conflict = host.conflict,
  ) {
    return {
      path: host.path,
      version: host.version,
      savedContent: host.savedContent,
      backendRevision: host.backendRevision,
      bom: host.bom,
      lineEnding: host.lineEnding,
      deleted: host.deleted,
      conflict,
      error,
      externalChange: host.externalChange,
      readOnly: this.descriptor.readOnly,
    };
  }
  private async hostState(
    host: HostDocument,
    error = host.error,
    conflict = host.conflict,
  ) {
    return this.execute<CoreDocument>("replica_host_state", {
      id: host.id,
      state: {
        ...this.replicaState(host, error, conflict),
        readOnly: this.descriptor.readOnly || this.offline,
      },
    });
  }
  private receive(receipt: RemoteReceipt): Promise<ServiceDocument> {
    const id = receipt.document.id;
    const transport = this.transport!;
    const previous = this.imports.get(id) ?? Promise.resolve();
    // Open/save replies and pushed updates may arrive together. Their join,
    // import and metadata acceptance form one ordered document operation.
    const result = previous
      .catch(() => {})
      .then(() => {
        this.requireTransport(transport);
        return this.importReceipt(receipt, transport);
      });
    this.imports.set(id, result);
    void result
      .finally(() => {
        if (this.imports.get(id) === result) this.imports.delete(id);
      })
      .catch(() => {});
    return result;
  }
  private async importReceipt(
    receipt: RemoteReceipt,
    transport: RemoteTransport,
  ) {
    const prior = this.hosts.get(receipt.document.id);
    if (receipt.document.savedContent === undefined && !prior)
      throw new VaultError("IO", "远端缺少初始磁盘元数据。");
    const host: HostDocument = {
      ...receipt.document,
      savedContent: receipt.document.savedContent ?? prior!.savedContent,
    };
    if (receipt.sequence <= (this.received.get(host.id) ?? -1))
      return this.document(
        await this.execute<CoreDocument>("read", { id: host.id }),
      );
    if (!this.hosts.has(host.id)) {
      await this.execute("replica_join", {
        document: {
          packets: [receipt.packet],
          writerId: receipt.writerId,
          state: this.replicaState(host),
        },
      });
    } else {
      await this.execute("apply", {
        id: host.id,
        command: { kind: "import", packet: receipt.packet, origin: "peer" },
      });
    }
    this.requireTransport(transport);
    if (!this.subscriptions.has(host.id))
      return this.document(
        await this.execute<CoreDocument>("read", { id: host.id }),
      );
    const raw = await this.hostState(host);
    this.requireTransport(transport);
    this.hosts.set(host.id, host);
    this.sync?.acknowledge(host.id, host.version);
    this.received.set(host.id, receipt.sequence);
    this.publish(raw, !prior);
    return this.document(raw);
  }
  private networkFailure(transport: RemoteTransport, error: unknown) {
    if (this.transport !== transport || this.stopping) return;
    const online = !this.offline;
    this.offline = true;
    this.sync?.stop(error, false);
    transport.close();
    if (online)
      this.scheduleRemote(async () => {
        if (this.transport === transport && !this.stopping)
          await this.pause(error);
      });
  }
  override collaboration() {
    return this.members;
  }
  override async setView(
    viewId: string,
    documentId: string | null,
    focused: boolean,
    selection: VersionedSelection | null = null,
  ) {
    if (documentId === null) {
      this.views.delete(viewId);
      if (!this.offline)
        await this.transport!.request("set_view", {
          viewId,
          documentId,
          focused: false,
          selection: null,
        });
      return;
    }
    this.views.set(viewId, { viewId, documentId, focused, selection });
    if (!this.offline) void this.sendView(viewId);
  }
  private async sendView(viewId: string) {
    if (this.sendingViews.has(viewId)) return;
    this.sendingViews.add(viewId);
    const transport = this.transport!;
    try {
      let sent: unknown;
      while (!this.offline && this.transport === transport) {
        const view = this.views.get(viewId);
        if (!view || view === sent || !this.subscriptions.has(view.documentId))
          break;
        sent = view;
        let selection: PresenceSelection | null = null;
        if (view.selection) {
          try {
            const anchors = await this.anchorsAt(
              view.documentId,
              view.selection.version,
              anchorPositions(view.selection.selection),
            );
            await this.sync!.wait(view.documentId, view.selection.version);
            selection = {
              version: view.selection.version,
              ranges: view.selection.selection.ranges.map((_, i) => ({
                anchor: anchors[i * 2],
                head: anchors[i * 2 + 1],
              })),
              mainIndex: view.selection.selection.mainIndex,
            };
          } catch (error) {
            if (!(error instanceof VaultError) || error.code !== "StaleVersion")
              throw error;
          }
        }
        this.requireTransport(transport);
        if (this.views.get(viewId) !== view) continue;
        await transport.request("set_view", {
          viewId,
          documentId: view.documentId,
          focused: view.focused,
          selection,
        });
      }
    } catch (error) {
      if (this.transport === transport && this.connectionFailure(error))
        this.networkFailure(transport, error);
    } finally {
      this.sendingViews.delete(viewId);
      // Session replacement can finish while an old checkpoint wait unwinds.
      if (
        this.transport !== transport &&
        !this.offline &&
        this.views.has(viewId)
      )
        void this.sendView(viewId);
    }
  }
  override async releaseDocument(id: string) {
    if (this.subscriptions.has(id)) {
      this.requireOnline();
      const transport = this.transport!;
      const sync = this.sync!;
      const current = await this.execute<CoreDocument>("read", { id });
      await sync.wait(id, current.snapshot.version);
      this.requireTransport(transport);
      await transport.request("unsubscribe", { id });
      this.requireTransport(transport);
      await this.execute("replica_release", { id });
      this.subscriptions.delete(id);
      for (const [viewId, view] of this.views)
        if (view.documentId === id) this.views.delete(viewId);
      this.composing.delete(id);
      this.deferred.delete(id);
    }
    this.unsupported.delete(id);
    await super.releaseDocument(id);
  }
  private requireTransport(transport: RemoteTransport) {
    if (this.transport !== transport)
      throw new VaultError("Closed", "协作会话已替换。");
    this.requireOnline();
  }
  private connectionFailure(error: unknown) {
    return (
      error instanceof VaultError &&
      ["IO", "PermissionDenied", "Closed"].includes(error.code)
    );
  }
  private async pause(error: unknown) {
    const transport = this.transport;
    this.offline = true;
    this.members = null;
    this.publishMembers(null);
    this.publishConnection({
      status: "offline",
      error: error instanceof Error ? error.message : String(error),
      unconfirmed: this.unconfirmed,
    });
    for (const host of this.hosts.values()) {
      if (this.transport !== transport) return;
      if (!this.subscriptions.has(host.id)) continue;
      const raw = await this.hostState(
        host,
        error instanceof Error ? error.message : String(error),
      );
      if (this.transport !== transport) return;
      this.publish(raw, true);
    }
  }
  override async open(path: VaultPath): Promise<ServiceDocument> {
    this.requireOnline();
    const transport = this.transport!;
    try {
      const receipt = await transport.request<RemoteReceipt>("open", {
        path,
      });
      this.requireTransport(transport);
      this.subscriptions.add(receipt.document.id);
      return await this.receive(receipt);
    } catch (error) {
      if (this.transport !== transport) throw error;
      if (this.connectionFailure(error)) await this.pause(error);
      if (!(error instanceof VaultError) || error.code !== "Unsupported")
        throw error;
      const document: ServiceDocument = {
        id: crypto.randomUUID(),
        path,
        content: "",
        savedContent: "",
        bom: false,
        lineEnding: "\n",
        readOnlyReason: error.message.includes("5 MiB")
          ? "文件超过 5 MiB，请通过文件树下载后编辑。"
          : "这个文件不是 UTF-8 文本，无法在此编辑。可通过文件树下载。",
        canPreview: false,

        error: null,
        conflict: false,
      };
      this.unsupported.set(document.id, document);
      return document;
    }
  }
  protected override ensureMutationAllowed() {
    this.requireOnline();
  }
  protected override async onMutation(mutation: CoreMutation, inReply = false) {
    await super.onMutation(mutation, inReply);
    const { update } = mutation;
    if (update.pending)
      throw new VaultError(
        "IO",
        "远端增量缺少历史依赖，协作已暂停。",
        mutation.document.path,
      );
    if (
      update.operation &&
      ["local", "undo", "redo"].includes(update.cause.kind)
    ) {
      if (mutation.history.status === "failed")
        throw decodeError(mutation.history.error);
      this.sync!.enqueue(mutation.document.id, update.operation, update.after);
    }
  }
  override async save(id: string): Promise<ServiceDocument> {
    const unsupported = this.unsupported.get(id);
    if (unsupported) return unsupported;
    this.requireOnline();
    const transport = this.transport!;
    const sync = this.sync!;
    // A filesystem observation or another editor can advance the host between
    // the user's save command and its execution. Import before retrying; never
    // overwrite a version the client has not seen.
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = await this.execute<CoreDocument>("read", { id });
      await sync.wait(id, current.snapshot.version);
      this.requireTransport(transport);
      try {
        const receipt = await transport.request<RemoteReceipt>("save", {
          id,
          version: current.snapshot.version,
        });
        this.requireTransport(transport);
        return await this.receive(receipt);
      } catch (error) {
        if (this.transport !== transport) throw error;
        if ((error as { code?: string }).code === "StaleVersion") {
          const receipt = await transport.request<RemoteReceipt>("open", {
            id,
          });
          this.requireTransport(transport);
          await this.receive(receipt);
          continue;
        }
        if (this.connectionFailure(error)) await this.pause(error);
        const raw = await this.hostState(
          this.hosts.get(id)!,
          error instanceof Error ? error.message : String(error),
          error instanceof VaultError && error.code === "Conflict",
        );
        this.publish(raw, true);
        return this.document(raw);
      }
    }
    throw new VaultError("Busy", "远端正文仍在变化，请稍后保存。");
  }
  override async retryObservation(id: string): Promise<ServiceDocument> {
    this.requireOnline();
    const transport = this.transport!;
    const receipt = await transport.request<RemoteReceipt>(
      "retry_observation",
      { id },
    );
    this.requireTransport(transport);
    return this.receive(receipt);
  }
  override async resolve(
    id: string,
    action: "overwrite" | "discard" | "retry",
  ) {
    if (action !== "retry")
      throw new VaultError(
        "Unsupported",
        "共享历史不能通过保存冲突丢弃或覆盖，请重试保存。",
        this.hosts.get(id)?.path,
      );
    return this.save(id);
  }
  async reconnect() {
    let descriptor: RemoteVaultDescriptor;
    try {
      descriptor = await this.http.describe();
    } catch (error) {
      await this.pause(error);
      throw error;
    }
    if (
      descriptor.vaultIdentity?.id !== this.descriptor.vaultIdentity?.id ||
      descriptor.vaultIdentity?.historyId !==
        this.descriptor.vaultIdentity?.historyId
    ) {
      const error = new VaultError(
        "Conflict",
        "远端 Vault 历史已改变，旧会话正文仍保留。请保留正文后重新打开连接。",
      );
      this.transport?.close();
      await this.pause(error);
      throw error;
    }
    this.offline = true;
    this.sync?.stop(new VaultError("Closed", "协作会话已替换。"), false);
    this.transport?.close();
    this.members = null;
    this.descriptor = descriptor;
    this.resetting = true;
    try {
      const documents = await this.connect();
      this.publishConnection({ status: "online", error: null });
      await this.executePreview("preview_invalidate_project", {});
      this.publishTree();
      return documents;
    } catch (error) {
      this.transport?.close();
      await this.pause(error);
      throw error;
    } finally {
      this.resetting = false;
    }
  }
  override async flush() {
    try {
      await this.sync?.drain();
    } catch (error) {
      throw new VaultError(
        "Conflict",
        `未确认的协作编辑仍保留，连接仍保留。请导出正文后恢复连接。${error instanceof Error ? error.message : String(error)}`,
      );
    }
    // A volatile replica has no file projection. Flush history, never host files.
    await this.execute("flush_history");
  }
  override async fileOperation(
    method: string,
    p: Record<string, unknown>,
  ): Promise<unknown> {
    this.requireOnline();
    const transport = this.transport!;
    try {
      const result = await this.performFileOperation(method, p, transport);
      this.requireTransport(transport);
      return result;
    } catch (error) {
      if (this.transport === transport && this.connectionFailure(error))
        await this.pause(error);
      throw error;
    } finally {
      if (
        this.transport === transport &&
        ["writeFile", "mkdir", "rename", "remove"].includes(method)
      )
        await this.executePreview("preview_invalidate_project", {});
    }
  }
  private async performFileOperation(
    method: string,
    p: Record<string, unknown>,
    transport: RemoteTransport,
  ): Promise<unknown> {
    this.requireOnline();
    const path = vaultPath(String(p.path ?? p.from ?? ""));
    const affected = [...this.hosts.values()].filter(
      (host) =>
        this.subscriptions.has(host.id) &&
        (host.path === path || host.path.startsWith(path + "/")),
    );
    if (["writeFile", "rename", "remove"].includes(method))
      for (const host of affected) {
        const raw = await this.execute<CoreDocument>("read", { id: host.id });
        this.requireTransport(transport);
        if (
          !this.descriptor.readOnly &&
          raw.snapshot.text !== raw.savedContent
        ) {
          const saved = await this.save(host.id);
          this.requireTransport(transport);
          if (saved.error)
            throw new VaultError(
              saved.conflict ? "Conflict" : "IO",
              saved.error,
              saved.path,
            );
        }
      }
    switch (method) {
      case "stat":
        return this.http.stat(path);
      case "readDir": {
        const entries = [];
        for await (const entry of this.http.readDir(path)) entries.push(entry);
        return entries;
      }
      case "readFile":
        return this.http.readFile(path);
      case "readFileSnapshot":
        return this.http.readFileSnapshot(path);
      case "mkdir":
        return this.http.mkdir(path, p.options as { recursive?: boolean });
      case "writeFile":
        await this.http.writeFile(
          path,
          p.data as Uint8Array,
          p.options as Parameters<HttpVaultBackend["writeFile"]>[2],
        );
        break;
      case "rename":
        await this.http.rename(path, vaultPath(String(p.to)));
        break;
      case "remove":
        await this.http.remove(path, p.options as { recursive?: boolean });
        break;
      default:
        throw new VaultError("Unsupported", "未知文件操作。", path);
    }
    this.requireTransport(transport);
    if (method === "remove") return;
    for (const host of affected) {
      if (!this.subscriptions.has(host.id)) continue;
      const receipt = await transport.request<RemoteReceipt>("open", {
        path:
          method === "rename"
            ? host.path.replace(path, String(p.to))
            : host.path,
      });
      this.requireTransport(transport);
      await this.receive(receipt);
    }
  }
  override async close() {
    await this.flush();
    this.stopping = true;
    this.sync?.stop(new VaultError("Closed", "协作会话已关闭。"), false);
    this.transport?.close();
    await super.close();
  }
}
