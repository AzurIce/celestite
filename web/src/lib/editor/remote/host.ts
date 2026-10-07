import { VaultError } from "../../vault/errors";
import { vaultPath, type VaultPath } from "../../vault/path";
import type { HttpVaultBackend, RemoteVaultDescriptor } from "../../vault/http";
import { EditorHost } from "../runtime/host";
import type { CoreDocument, CoreMutation, CorePort } from "../core";
import { decodeError } from "../rpc";
import type {
  ServiceDocument,
  ServiceEvent,
  SyncPacket,
  Version,
} from "../contract";
import { RemoteTransport, type RemoteReceipt } from "./transport";

/** Private online replica: core owns history/undo; the transport carries
 * committed updates. Host file saves remain explicit. */
export class RemoteEditorHost extends EditorHost {
  private hosts = new Map<string, CoreDocument>();
  private unsupported = new Map<string, ServiceDocument>();
  private offline = true;
  private resetting = false;
  private unconfirmed = false;
  private transport?: RemoteTransport;
  private operation = 0;
  private composing = new Set<string>();
  private deferred = new Map<string, RemoteReceipt[]>();
  private stopping = false;
  private received = new Map<string, number>();
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
    const transport = new RemoteTransport(
      this.http.url,
      identity,
      (receipt) => {
        if (receipt.kind === "tree") {
          this.scheduleRemote(async () => {
            if (this.transport === transport && !this.offline) {
              await this.executePreview("preview_invalidate_project", {});
              this.publishTree();
            }
          });
          return;
        }
        setTimeout(
          () =>
            this.scheduleRemote(async () => {
              if (this.transport !== transport || this.offline) return;
              if (this.composing.has(receipt.document.id)) {
                const pending = this.deferred.get(receipt.document.id) ?? [];
                pending.push(receipt);
                this.deferred.set(receipt.document.id, pending);
                if (pending.length <= 256) return;
                transport.close();
                await this.pause(
                  new VaultError(
                    "IO",
                    "组合输入期间的远端更新过多；正文仍保留。",
                  ),
                );
                return;
              }
              try {
                await this.receive(receipt);
              } catch (error) {
                transport.close();
                await this.pause(error);
              }
            }),
          0,
        );
      },
      (error) => {
        if (!this.stopping)
          setTimeout(
            () =>
              this.scheduleRemote(async () => {
                if (this.transport === transport && !this.offline)
                  await this.pause(error);
              }),
            0,
          );
      },
    );
    this.transport = transport;
    try {
      const receipts = await transport.ready;
      const hosts = new Map<string, CoreDocument>();
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
          snapshot: { ...receipt.document.snapshot, text: "" },
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
      this.hosts = new Map(states.map((state) => [state.id, state]));
      this.received = received;
      this.operation = 0;
      this.clearPatches();
      this.composing.clear();
      this.deferred.clear();
      this.offline = false;
      this.unconfirmed = false;
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
        for (const receipt of deferred) await this.receive(receipt);
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
    host: CoreDocument,
    error = host.error,
    conflict = host.conflict,
  ) {
    return {
      path: host.path,
      version: host.snapshot.version,
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
    host: CoreDocument,
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
  private async receive(receipt: RemoteReceipt) {
    const prior = this.hosts.get(receipt.document.id);
    if (receipt.document.savedContent === undefined && !prior)
      throw new VaultError("IO", "远端缺少初始磁盘元数据。");
    const host: CoreDocument = {
      ...receipt.document,
      savedContent: receipt.document.savedContent ?? prior!.savedContent,
      snapshot: { ...receipt.document.snapshot, text: "" },
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
    const raw = await this.hostState(host);
    this.hosts.set(host.id, host);
    this.received.set(host.id, receipt.sequence);
    this.publish(raw, !prior);
    return this.document(raw);
  }
  private connectionFailure(error: unknown) {
    return (
      error instanceof VaultError &&
      ["IO", "PermissionDenied", "Closed"].includes(error.code)
    );
  }
  private async pause(error: unknown) {
    this.offline = true;
    this.publishConnection({
      status: "offline",
      error: error instanceof Error ? error.message : String(error),
      unconfirmed: this.unconfirmed,
    });
    for (const host of this.hosts.values()) {
      const raw = await this.hostState(
        host,
        error instanceof Error ? error.message : String(error),
      );
      this.publish(raw, true);
    }
  }
  override async open(path: VaultPath): Promise<ServiceDocument> {
    this.requireOnline();
    try {
      return await this.receive(
        await this.transport!.request<RemoteReceipt>("open", { path }),
      );
    } catch (error) {
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
      await this.submit(mutation.document.id, update.operation, update.after);
    }
  }
  private async submit(id: string, packet: SyncPacket, version: Version) {
    this.unconfirmed = true;
    try {
      await this.transport!.request("updates", {
        id,
        packet,
        version,
        operation: ++this.operation,
      });
      this.unconfirmed = false;
    } catch (error) {
      this.transport?.close();
      await this.pause(error);
      throw error;
    }
  }
  override async save(id: string): Promise<ServiceDocument> {
    const unsupported = this.unsupported.get(id);
    if (unsupported) return unsupported;
    this.requireOnline();
    // A filesystem observation or another editor can advance the host between
    // the user's save command and its execution. Import before retrying; never
    // overwrite a version the client has not seen.
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = await this.execute<CoreDocument>("read", { id });
      try {
        return await this.receive(
          await this.transport!.request<RemoteReceipt>("save", {
            id,
            version: current.snapshot.version,
          }),
        );
      } catch (error) {
        if ((error as { code?: string }).code === "StaleVersion") {
          await this.receive(
            await this.transport!.request<RemoteReceipt>("open", {
              path: current.path,
            }),
          );
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
    const receipt = await this.transport!.request<RemoteReceipt>(
      "retry_observation",
      { id },
    );
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
    this.transport?.close();
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
    if (this.unconfirmed)
      throw new VaultError(
        "Conflict",
        "存在尚未确认的协作编辑，请导出正文并重新连接。",
      );
    // A volatile replica has no file projection. Flush history, never host files.
    await this.execute("flush_history");
  }
  override async fileOperation(
    method: string,
    p: Record<string, unknown>,
  ): Promise<unknown> {
    try {
      return await this.performFileOperation(method, p);
    } catch (error) {
      if (this.connectionFailure(error)) await this.pause(error);
      throw error;
    } finally {
      if (["writeFile", "mkdir", "rename", "remove"].includes(method))
        await this.executePreview("preview_invalidate_project", {});
    }
  }
  private async performFileOperation(
    method: string,
    p: Record<string, unknown>,
  ): Promise<unknown> {
    this.requireOnline();
    const path = vaultPath(String(p.path ?? p.from ?? ""));
    const affected = [...this.hosts.values()].filter(
      (host) => host.path === path || host.path.startsWith(path + "/"),
    );
    if (["writeFile", "rename", "remove"].includes(method))
      for (const host of affected) {
        const raw = await this.execute<CoreDocument>("read", { id: host.id });
        if (
          !this.descriptor.readOnly &&
          raw.snapshot.text !== raw.savedContent
        ) {
          const saved = await this.save(host.id);
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
    if (method === "remove") return;
    for (const host of affected) {
      const receipt = await this.transport!.request<RemoteReceipt>("open", {
        path:
          method === "rename"
            ? host.path.replace(path, String(p.to))
            : host.path,
      });
      await this.receive(receipt);
    }
  }
  override async close() {
    await this.flush();
    this.stopping = true;
    this.transport?.close();
    await super.close();
  }
}
