import { VaultError } from "../../vault/errors";
import { vaultPath, type VaultPath } from "../../vault/path";
import type { HttpVaultBackend, RemoteVaultDescriptor } from "../../vault/http";
import { EditorSession } from "../runtime/session";
import type { CoreDocument, CoreMutation, CorePort } from "../core";
import type {
  ServiceDocument,
  HostDocument,
  CollaborationSnapshot,
  VersionedSelection,
  PresenceSelection,
  ServiceEvent,
  HistoryPacket,
  SessionReplacement,
} from "../contract";
import { RemoteTransport, type RemoteReceipt } from "./transport";
import { SyncSession } from "./session";
import { anchorPositions } from "../presence";
import { RemoteInbox } from "./inbox";
import { executeFile, fileAffectsText, fileMutation } from "../files";

interface RemoteView {
  viewId: string;
  documentId: string;
  focused: boolean;
  selection: VersionedSelection | null;
}

/** Private online replica: core owns history/undo; the transport carries
 * committed updates. Host file saves remain explicit. */
export class RemoteEditorSession extends EditorSession {
  private hosts = new Map<string, HostDocument>();
  private subscriptions = new Set<string>();
  private members: CollaborationSnapshot | null = null;
  private views = new Map<string, RemoteView>();
  private sendingViews = new Set<string>();
  private sync?: SyncSession;
  private unsupported = new Map<string, ServiceDocument>();
  private offline = true;
  private resetting = false;
  private get unconfirmed() {
    return this.sync?.unconfirmed ?? false;
  }
  private transport?: RemoteTransport;
  private stopping = false;
  private received = new Map<string, number>();
  private imports = new Map<string, Promise<ServiceDocument>>();
  private inbox = new RemoteInbox();
  constructor(
    core: CorePort,
    private http: HttpVaultBackend,
    private descriptor: RemoteVaultDescriptor,
    emit: (event: ServiceEvent) => void,
    private scheduleRemote: (task: () => Promise<unknown>) => void,
  ) {
    super(core, emit);
  }
  async connect(descriptor = this.descriptor): Promise<SessionReplacement> {
    const identity = descriptor.vault!;
    this.inbox.stop();
    const inbox = (this.inbox = new RemoteInbox());
    const current = () => {
      if (this.transport !== transport || inbox.stopped)
        throw new VaultError("Closed", "协作会话已替换。");
    };
    const transport = new RemoteTransport(
      this.http.url,
      identity,
      (receipt) => {
        if (this.transport !== transport || inbox.stopped) return;
        if (receipt.kind === "members") {
          this.members = receipt.state;
          if (!this.offline) this.publishMembers(receipt.state);
          return;
        }
        if (receipt.kind === "tree") {
          this.scheduleRemote(async () => {
            if (this.transport === transport && !this.offline) {
              this.publishTree();
            }
          });
          return;
        }
        try {
          inbox.admit(receipt);
        } catch (error) {
          this.networkFailure(transport, error);
          return;
        }
        if (inbox.holdStartup(receipt)) return;
        this.scheduleRemote(async () => {
          let held = false;
          try {
            if (
              this.transport !== transport ||
              this.offline ||
              !this.subscriptions.has(receipt.document.id)
            )
              return;
            held = inbox.hold(receipt);
            if (held) return;
            await this.receive(receipt);
          } catch (error) {
            if (this.subscriptions.has(receipt.document.id))
              this.networkFailure(transport, error);
          } finally {
            if (!held) inbox.release(receipt);
          }
        });
      },
      (error) => this.networkFailure(transport, error),
    );
    this.transport = transport;
    // The old sender still owns any unconfirmed edits until replacement commits.
    const sync = new SyncSession(
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
    let committed = false;
    let replacement!: { documents: CoreDocument[]; sequence: number };
    try {
      await transport.ready;
      current();
      const receipts: RemoteReceipt[] = [];
      for (const id of this.subscriptions) {
        receipts.push(await transport.request<RemoteReceipt>("open", { id }));
        current();
      }
      // View registration can fail, and must finish before old histories vanish.
      // setView may change while network requests await; restore the latest table.
      const sentViews = new Map<string, RemoteView>();
      for (;;) {
        for (const [viewId, sent] of sentViews)
          if (
            !this.views.has(viewId) ||
            !this.subscriptions.has(sent.documentId)
          ) {
            await transport.request("set_view", {
              viewId,
              documentId: null,
              focused: false,
              selection: null,
            });
            current();
            sentViews.delete(viewId);
          }
        for (const [viewId, view] of this.views)
          if (
            this.subscriptions.has(view.documentId) &&
            sentViews.get(viewId) !== view
          ) {
            await transport.request("set_view", { ...view, selection: null });
            current();
            sentViews.set(viewId, view);
          }
        if (
          [...this.views].every(
            ([id, view]) =>
              !this.subscriptions.has(view.documentId) ||
              sentViews.get(id) === view,
          ) &&
          [...sentViews].every(([id, view]) => this.views.get(id) === view)
        )
          break;
      }
      const hosts = new Map<string, HostDocument>();
      const documents = new Map<
        string,
        { packets: HistoryPacket[]; peerId: string }
      >();
      const received = new Map<string, number>();
      const addReceipt = (receipt: RemoteReceipt) => {
        const id = receipt.document.id;
        if (!this.subscriptions.has(id)) return;
        const host = this.receiptHost(receipt, hosts.get(id));
        const sequence = received.get(id) ?? -1;
        if (receipt.sequence <= sequence) return;
        const next = documents.get(id) ?? {
          packets: [],
          peerId: receipt.peerId,
        };
        if (next.peerId !== receipt.peerId)
          throw new VaultError("IO", "初始协作会话不连续。");
        next.packets.push(receipt.packet);
        documents.set(id, next);
        hosts.set(id, host);
        received.set(id, receipt.sequence);
      };
      for (const receipt of receipts) addReceipt(receipt);
      const params: Record<string, unknown> = {};
      let startup: RemoteReceipt[] = [];
      await this.execute<CoreDocument[]>("replica_session", params, {
        before: () => {
          current();
          // Stay in startup mode while the core request awaits. Arrivals after
          // this point are ordinary updates of the committed session.
          startup = inbox.drainStartup();
          for (const receipt of startup) addReceipt(receipt);
          // A release may commit while this replacement waits for its lease.
          // Drop its earlier open receipts from the entire prepared catalogue.
          for (const id of documents.keys())
            if (!this.subscriptions.has(id)) {
              documents.delete(id);
              hosts.delete(id);
              received.delete(id);
            }
          params.documents = [...documents].map(([id, document]) => ({
            ...document,
            state: {
              ...this.replicaState(hosts.get(id)!),
              readOnly: descriptor.readOnly,
            },
          }));
        },
        accept: (documents) => {
          // Core success is the irreversible commit point, including native IPC
          // that may complete after transport failure. Never report old buffers.
          committed = true;
          replacement = { documents, sequence: this.eventSequence };
          this.descriptor = descriptor;
          this.hosts = hosts;
          this.received = received;
          this.sync = sync;
          for (const host of hosts.values())
            sync.acknowledge(host.id, host.version);
          this.clearPatches();
          for (const view of this.views.values()) view.selection = null;
          this.offline = inbox.stopped || this.transport !== transport;
          if (this.offline)
            sync.stop(new VaultError("Closed", "远端连接已中断。"), false);
          for (const receipt of startup) inbox.release(receipt);
        },
      });
      // Native IPC can yield long enough for an offline setView to change the
      // table after preparation. These are changes to the committed session.
      if (!this.offline) {
        for (const [viewId] of sentViews)
          if (
            !this.views.has(viewId) ||
            !this.subscriptions.has(this.views.get(viewId)!.documentId)
          ) {
            await transport.request("set_view", {
              viewId,
              documentId: null,
              focused: false,
              selection: null,
            });
            current();
          }
        for (const [viewId, view] of this.views)
          if (sentViews.get(viewId) !== view) await this.sendView(viewId);
      }
      if (!this.offline)
        for (let receipt; (receipt = inbox.nextStartup());) {
          try {
            if (this.subscriptions.has(receipt.document.id))
              await this.receive(receipt);
          } finally {
            inbox.release(receipt);
          }
        }
    } catch (error) {
      inbox.stop();
      this.networkFailure(transport, error);
      transport.close();
      if (!committed) throw error;
      // A late push or connection loss cannot undo a successful core replacement.
    }
    if (this.offline)
      await this.pause(
        new VaultError("Closed", "远端连接已中断，正文已保留。"),
      ).catch(() => {});
    else if (this.members) this.publishMembers(this.members);
    // The successful replacement is the only snapshot baseline. Later imports
    // and metadata are delivered as events after its sequence, even if derived
    // offline-state IO fails. No later read can reverse this commit.
    return {
      documents: replacement.documents.map((state) => this.document(state)),
      sequence: replacement.sequence,
    };
  }

  async composition(id: string, active: boolean) {
    const inbox = this.inbox;
    const transport = this.transport;
    if (active) inbox.compose(id);
    else {
      const deferred = inbox.take(id);
      try {
        if (!this.offline)
          for (const receipt of deferred) {
            this.requireTransport(transport!);
            await this.receive(receipt);
            this.requireTransport(transport!);
            inbox.release(receipt);
          }
      } catch (error) {
        if (transport) this.networkFailure(transport, error);
        throw error;
      } finally {
        for (const receipt of deferred) inbox.release(receipt);
      }
    }
  }
  private requireOnline() {
    if (this.offline || !this.transport)
      throw new VaultError("Closed", "远端连接已中断，编辑正文仍保留。");
    return this.transport;
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
      fileRevision: host.fileRevision,
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
        if (!this.subscriptions.has(id))
          throw new VaultError("Closed", "远端文档订阅已结束。");
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
  private receiptHost(
    receipt: RemoteReceipt,
    prior?: HostDocument,
  ): HostDocument {
    if (receipt.document.savedContent === undefined && !prior)
      throw new VaultError("IO", "远端缺少初始磁盘元数据。");
    return {
      ...receipt.document,
      savedContent: receipt.document.savedContent ?? prior!.savedContent,
    };
  }
  private async importReceipt(
    receipt: RemoteReceipt,
    transport: RemoteTransport,
  ) {
    const prior = this.hosts.get(receipt.document.id);
    const host = this.receiptHost(receipt, prior);
    if (receipt.sequence <= (this.received.get(host.id) ?? -1))
      return this.document(
        await this.execute<CoreDocument>("read", { id: host.id }),
      );
    if (!this.hosts.has(host.id)) {
      await this.execute("replica_join", {
        document: {
          packets: [receipt.packet],
          peerId: receipt.peerId,
          state: this.replicaState(host),
        },
      });
    } else {
      await this.execute("apply", {
        id: host.id,
        command: { kind: "import", packet: receipt.packet },
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
    this.inbox.stop();
    this.sync?.stop(error, false);
    transport.close();
    if (online)
      this.scheduleRemote(async () => {
        if (this.transport === transport && !this.stopping)
          await this.pause(error);
      });
  }
  collaboration() {
    return this.members;
  }
  async setView(
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
  async releaseDocument(id: string) {
    if (this.subscriptions.has(id)) {
      const transport = this.requireOnline();
      const sync = this.sync!;
      const current = await this.execute<CoreDocument>("read", { id });
      await sync.wait(id, current.version);
      this.requireTransport(transport);
      await transport.request("unsubscribe", { id });
      this.requireTransport(transport);
      await this.execute(
        "replica_release",
        { id },
        {
          before: () => this.requireTransport(transport),
          accept: () => {
            // Match the successful core release before a queued replacement
            // captures its document inventory under the next core lease.
            this.subscriptions.delete(id);
            for (const [viewId, view] of this.views)
              if (view.documentId === id) this.views.delete(viewId);
            this.inbox.discard(id);
          },
        },
      );
    }
    this.unsupported.delete(id);
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
    this.inbox.stop();
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
  async open(path: VaultPath): Promise<ServiceDocument> {
    const transport = this.requireOnline();
    let receipt: RemoteReceipt;
    try {
      receipt = await transport.request<RemoteReceipt>("open", { path });
      this.requireTransport(transport);
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
        readOnlyReason: /5 MiB|read limit|file byte limit|supported size/i.test(
          error.message,
        )
          ? "正文超过 5 MiB，请通过文件树下载后编辑。"
          : "这个文件不是 UTF-8 文本，无法在此编辑。可通过文件树下载。",
        canPreview: false,

        error: null,
        conflict: false,
      };
      this.unsupported.set(document.id, document);
      return document;
    }
    const id = receipt.document.id;
    const subscribed = this.subscriptions.has(id);
    this.subscriptions.add(id);
    try {
      return await this.receive(receipt);
    } catch (error) {
      // A valid host file can still contain an unsupported/corrupt CRDT packet.
      // That is a failed join, never a non-UTF-8 placeholder with another id.
      if (!subscribed) {
        this.subscriptions.delete(id);
        this.inbox.discard(id);
        if (this.transport === transport && !this.offline)
          try {
            await transport.request("unsubscribe", { id });
          } catch (cleanupError) {
            this.networkFailure(transport, cleanupError);
            await this.pause(cleanupError);
          }
      }
      if (this.transport === transport && this.connectionFailure(error)) {
        this.networkFailure(transport, error);
        await this.pause(error);
      }
      throw error;
    }
  }
  protected override ensureMutationAllowed() {
    this.requireOnline();
  }
  protected override onMutation(mutation: CoreMutation, inReply = false) {
    super.onMutation(mutation, inReply);
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
      this.sync!.enqueue(mutation.document.id, update.operation, update.after);
    }
  }
  async save(id: string): Promise<ServiceDocument> {
    const unsupported = this.unsupported.get(id);
    if (unsupported) return unsupported;
    const transport = this.requireOnline();
    const sync = this.sync!;
    // A filesystem observation or another editor can advance the host between
    // the user's save command and its execution. Import before retrying; never
    // overwrite a version the client has not seen.
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = await this.execute<CoreDocument>("read", { id });
      await sync.wait(id, current.version);
      this.requireTransport(transport);
      try {
        const receipt = await transport.request<RemoteReceipt>("save", {
          id,
          version: current.version,
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
  async checkpoint(id: string) {
    const transport = this.requireOnline();
    const document = await this.execute<CoreDocument>("read", { id });
    await this.sync!.wait(id, document.version);
    this.requireTransport(transport);
    return this.document(await this.execute<CoreDocument>("read", { id }));
  }
  async retryObservation(id: string): Promise<ServiceDocument> {
    const transport = this.requireOnline();
    const receipt = await transport.request<RemoteReceipt>(
      "retry_observation",
      { id },
    );
    this.requireTransport(transport);
    return this.receive(receipt);
  }
  async resolve(id: string, action: "overwrite" | "discard" | "retry") {
    if (action !== "retry")
      throw new VaultError(
        "Unsupported",
        "共享历史不能通过保存冲突丢弃或覆盖，请重试保存。",
        this.hosts.get(id)?.path,
      );
    return this.save(id);
  }
  async reconnect() {
    if (this.resetting) throw new VaultError("Busy", "远端连接正在恢复。");
    this.resetting = true;
    this.offline = true;
    this.sync?.stop(new VaultError("Closed", "协作会话已替换。"), false);
    this.transport?.close();
    this.members = null;
    try {
      const descriptor = await this.http.describe();
      if (
        descriptor.vault?.vaultId !== this.descriptor.vault?.vaultId ||
        descriptor.vault?.historyId !== this.descriptor.vault?.historyId
      )
        throw new VaultError(
          "Conflict",
          "远端 Vault 历史已改变，旧会话正文仍保留。请保留正文后重新打开连接。",
        );
      const documents = await this.connect(descriptor);
      if (!this.offline)
        this.publishConnection({
          status: "online",
          error: null,
          unconfirmed: false,
        });
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
  async flush() {
    try {
      await this.sync?.drain();
    } catch (error) {
      throw new VaultError(
        "Conflict",
        `未确认的协作编辑仍保留，连接仍保留。请导出正文后恢复连接。${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  async fileOperation(
    method: string,
    p: Record<string, unknown>,
  ): Promise<unknown> {
    const transport = this.requireOnline();
    try {
      const result = await this.performFileOperation(method, p, transport);
      this.requireTransport(transport);
      return result;
    } catch (error) {
      if (this.transport === transport && this.connectionFailure(error))
        await this.pause(error);
      throw error;
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
    const mutatesText = fileMutation(method) && fileAffectsText(method);
    if (mutatesText)
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
    const result = await executeFile(this.http, method, p);
    // Reads and mkdir do not reopen text or implicitly save the remote body.
    if (!mutatesText) return result;
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
    return result;
  }
  async close() {
    await this.flush();
    await this.execute("close");
    this.dispose();
    await this.http.close();
  }
  dispose() {
    this.stopping = true;
    this.inbox.stop();
    this.sync?.stop(new VaultError("Closed", "协作会话已关闭。"), false);
    this.transport?.close();
  }
}
