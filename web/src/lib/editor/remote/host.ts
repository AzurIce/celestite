import { ChangeSet } from "@codemirror/state";
import { VaultError } from "../../vault/errors";
import { vaultPath, type VaultPath } from "../../vault/path";
import type { HttpVaultBackend, RemoteVaultDescriptor } from "../../vault/http";
import {
  EditorHost,
  type CoreDocument,
  type CoreEdit,
  type CorePort,
} from "../runtime/host";
import type {
  EditResult,
  SelectionContext,
  ServiceDocument,
  ServiceEvent,
  SyncPacket,
  TextEdit,
  Version,
} from "../contract";
import { RemoteTransport, type RemoteReceipt } from "./transport";
import { editsOf, sameVersion } from "../view-changes";

interface Patch {
  before: Version;
  after: Version;
  changes: ChangeSet;
}
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
  private patches = new Map<string, Patch[]>();
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
  async connect(token: string, reset = false) {
    const identity = this.descriptor.vaultIdentity!;
    const transport = new RemoteTransport(
      this.http.url,
      token,
      identity,
      (receipt) => {
        if (receipt.kind === "tree") {
          if (this.transport === transport && !this.offline) this.publishTree();
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
    const receipts = await transport.ready;
    this.operation = 0;
    this.patches.clear();
    this.received.clear();
    this.composing.clear();
    this.deferred.clear();
    // A new session only contains host history. Never replay the old writer.
    const present = new Set(receipts.map((receipt) => receipt.document.id));
    for (const receipt of receipts)
      await this.receive(receipt, reset && receipt.packet.kind === "snapshot");
    for (const host of this.hosts.values())
      if (reset && !present.has(host.id)) host.deleted = true;
    this.offline = false;
    this.unconfirmed = false;
    const documents: ServiceDocument[] = [];
    for (const host of this.hosts.values()) {
      const raw = await this.hostState(host);
      documents.push(this.document(raw));
    }
    return documents;
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
      super.publish({ ...raw, autosaveDelay: null }, content, change);
  }
  protected override document(
    raw: CoreDocument,
    content = true,
  ): ServiceDocument {
    return {
      ...super.document(raw, content),
      readOnlyReason: this.offline
        ? "远端连接中断，正文已保留；请重新连接后继续编辑。"
        : raw.deleted
          ? "文件已被删除，正文仍可复制。"
          : this.descriptor.readOnly
            ? "当前 Vault 只读。"
            : null,
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
        path: host.path,
        version: host.snapshot.version,
        savedContent: host.savedContent,
        backendRevision: host.backendRevision,
        bom: host.bom,
        lineEnding: host.lineEnding,
        deleted: host.deleted,
        conflict,
        error,
        readOnly: this.descriptor.readOnly || this.offline,
      },
    });
  }
  private async receive(receipt: RemoteReceipt, reset = false) {
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
    this.received.set(host.id, receipt.sequence);
    let change: ServiceDocument["change"];
    if (!this.hosts.has(host.id) || reset) {
      await this.execute(reset ? "replica_reset" : "join", {
        path: host.path,
        packet: receipt.packet,
        writerId: receipt.writerId,
      });
    } else {
      const before = await this.execute<CoreDocument>("read", { id: host.id });
      const known = Object.entries(host.snapshot.version.clocks).every(
        ([peer, clock]) => (before.snapshot.version.clocks[peer] ?? 0) >= clock,
      );
      if (!known) {
        const imported = await this.execute<{
          result: { event: { edits: TextEdit[] } | null; pending: boolean };
          document: CoreDocument;
        }>("import", { id: host.id, packet: receipt.packet });
        if (imported.result.pending)
          throw new VaultError(
            "IO",
            "远端增量缺少历史依赖，协作已暂停。",
            host.path,
          );
        const edits = imported.result.event?.edits ?? [];
        change = { before: before.snapshot.text, edits };
        const patches = this.patches.get(host.id) ?? [];
        patches.push({
          before: before.snapshot.version,
          after: imported.document.snapshot.version,
          changes: ChangeSet.of(edits, before.snapshot.text.length),
        });
        if (patches.length > 128) patches.shift();
        this.patches.set(host.id, patches);
      }
    }
    this.hosts.set(host.id, host);
    const raw = await this.hostState(host);
    // Deleted buffers remain visible/readable. publish in the base skips them.
    this.publish({ ...raw, deleted: false }, true, change);
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
      this.publish({ ...raw, deleted: false }, true);
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
        saving: false,
        error: null,
        conflict: false,
      };
      this.unsupported.set(document.id, document);
      return document;
    }
  }
  override async edit(
    id: string,
    version: Version,
    edits: TextEdit[],
    context: SelectionContext,
    userEvent: string,
  ): Promise<EditResult> {
    this.requireOnline();
    const current = await this.execute<CoreDocument>("read", { id });
    if (!sameVersion(version, current.snapshot.version)) {
      let pending: ChangeSet | undefined;
      for (const patch of this.patches.get(id) ?? []) {
        if (!sameVersion(patch.before, version)) continue;
        pending ??= ChangeSet.of(edits, patch.changes.length);
        pending = pending.map(patch.changes, true);
        context = {
          ...context,
          ranges: context.ranges.map((r) => ({
            anchor: patch.changes.mapPos(r.anchor),
            head: patch.changes.mapPos(r.head),
          })),
        };
        version = patch.after;
      }
      if (!pending || !sameVersion(version, current.snapshot.version))
        throw new VaultError(
          "Conflict",
          "输入的历史版本已过期，输入仍保留。",
          current.path,
        );
      edits = editsOf(pending);
    }
    const result = await this.execute<CoreEdit>("edit", {
      id,
      version,
      edits,
      context,
      userEvent,
    });
    await this.submit(id, version, result.document.snapshot.version);
    return { document: this.document(result.document), edits: result.edits };
  }
  override async undo(
    id: string,
    context: SelectionContext,
    redo: boolean,
    version?: Version,
  ): Promise<EditResult> {
    this.requireOnline();
    const before = await this.execute<CoreDocument>("read", { id });
    if (version && !sameVersion(version, before.snapshot.version)) {
      for (const patch of this.patches.get(id) ?? []) {
        if (!sameVersion(patch.before, version)) continue;
        context = {
          ...context,
          ranges: context.ranges.map((r) => ({
            anchor: patch.changes.mapPos(r.anchor),
            head: patch.changes.mapPos(r.head),
          })),
        };
        version = patch.after;
      }
      if (!sameVersion(version, before.snapshot.version))
        throw new VaultError(
          "Conflict",
          "撤销选区的历史版本已过期，正文仍保留。",
        );
    }
    const result = await this.execute<CoreEdit>("undo", { id, context, redo });
    await this.submit(
      id,
      before.snapshot.version,
      result.document.snapshot.version,
    );
    return {
      document: this.document(result.document),
      edits: result.edits,
      ...(result.restoredSelection
        ? { restoredSelection: result.restoredSelection }
        : {}),
    };
  }
  private async submit(id: string, before: Version, after: Version) {
    if (sameVersion(before, after)) return;
    const packet = await this.execute<SyncPacket>("export_updates", {
      id,
      version: before,
    });
    this.unconfirmed = true;
    try {
      await this.transport!.request("updates", {
        id,
        packet,
        version: after,
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
  override async resolve(id: string, _action: "overwrite" | "discard") {
    // Physical-file changes are already merged by the host bridge. A client
    // cannot discard the shared unsaved history of other writers.
    return this.save(id);
  }
  async authorize(token: string) {
    this.http.authorize(token);
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
      const documents = await this.connect(token, true);
      this.publishConnection({ status: "online", error: null });
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
    if (this.descriptor.readOnly) return;
    this.requireOnline();
    for (const host of this.hosts.values()) {
      const raw = await this.execute<CoreDocument>("read", { id: host.id });
      if (raw.deleted) continue;
      if (raw.snapshot.text !== raw.savedContent || raw.error) {
        const saved = await this.save(host.id);
        if (saved.error) throw new VaultError("IO", saved.error, saved.path);
      }
    }
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
    if (["readFile", "writeFile", "rename", "remove"].includes(method))
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
