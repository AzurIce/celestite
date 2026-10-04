import { VaultError } from "../vault/errors";
import { vaultPath, type VaultPath } from "../vault/path";
import type { HttpVaultBackend, RemoteVaultDescriptor } from "../vault/http";
import { OpfsEditorHost, type CoreDocument, type CorePort } from "./opfs-host";
import type { ServiceDocument, ServiceEvent, SyncPacket } from "./contract";

interface Receipt {
  document: CoreDocument;
  packet: SyncPacket;
}
/** Transport adapter for a private replica. Editing, undo, mapping and file
 * conflict policy remain in Rust; receipts are accepted only after host IO. */
export class RemoteEditorHost extends OpfsEditorHost {
  private hosts = new Map<string, CoreDocument>();
  private unsupported = new Map<string, ServiceDocument>();
  private offline = false;
  constructor(
    core: CorePort,
    private http: HttpVaultBackend,
    private descriptor: RemoteVaultDescriptor,
    emit: (event: ServiceEvent) => void,
    schedule: (task: () => Promise<unknown>) => void,
  ) {
    super(core, http, emit, schedule);
  }
  private route(id: string) {
    return `/documents/${encodeURIComponent(id)}`;
  }
  protected override document(
    raw: CoreDocument,
    content = true,
  ): ServiceDocument {
    return {
      ...super.document(raw, content),
      readOnlyReason: this.offline
        ? "远端连接中断，正文已保留；请重新连接后继续编辑。"
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
  private async receive(receipt: Receipt, reset = false) {
    if (reset)
      await this.execute("replica_reset", {
        path: receipt.document.path,
        packet: receipt.packet,
      });
    else
      await this.execute("import", {
        id: receipt.document.id,
        packet: receipt.packet,
      });
    this.hosts.set(receipt.document.id, receipt.document);
    const raw = await this.hostState(receipt.document);
    this.publish(raw, true);
    return this.document(raw);
  }
  private connectionFailure(error: unknown) {
    return (
      error instanceof VaultError &&
      ["IO", "PermissionDenied"].includes(error.code)
    );
  }
  private async pause(error: unknown, except?: string) {
    this.offline = true;
    for (const host of this.hosts.values()) {
      if (host.id === except) continue;
      const current = await this.execute<CoreDocument>("read", { id: host.id });
      this.publish(
        await this.hostState(
          host,
          error instanceof Error ? error.message : String(error),
          current.conflict,
        ),
        true,
      );
    }
  }
  override async open(path: VaultPath): Promise<ServiceDocument> {
    try {
      const host = await this.http.documentRequest<CoreDocument>(
        "/documents/open",
        { path },
      );
      const packet = await this.http.documentRequest<SyncPacket>(
        this.route(host.id) + "/snapshot",
      );
      if (!this.hosts.has(host.id))
        await this.execute("join", { path: host.path, packet });
      return await this.receive({ document: host, packet });
    } catch (error) {
      if (this.connectionFailure(error)) await this.pause(error);
      if (
        !(error instanceof VaultError) ||
        error.code !== "Unsupported" ||
        (!error.message.includes("5 MiB") && !error.message.includes("UTF-8"))
      )
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
  private async commit(id: string, action: "save" | "overwrite" | "discard") {
    const unsupported = this.unsupported.get(id);
    if (unsupported) return unsupported;
    const host = this.hosts.get(id);
    if (!host) throw new VaultError("NotFound", "远端文档未打开。", id);
    if (this.descriptor.readOnly)
      throw new VaultError("PermissionDenied", "当前 Vault 只读。", host.path);
    try {
      const packet =
        action === "discard"
          ? null
          : await this.execute<SyncPacket>("export_snapshot", { id });
      const receipt = await this.http.documentRequest<Receipt>(
        this.route(id) + "/client-commit",
        {
          packet,
          expectedRevision: host.backendRevision,
          action,
        },
      );
      this.offline = false;
      return await this.receive(receipt, action === "discard");
    } catch (error) {
      this.offline = this.connectionFailure(error);
      const raw = await this.hostState(
        host,
        error instanceof Error ? error.message : String(error),
        error instanceof VaultError && error.code === "Conflict",
      );
      this.publish(raw, true);
      if (this.offline) await this.pause(error, id);
      return this.document(raw);
    }
  }
  override async save(id: string) {
    return this.commit(id, "save");
  }
  override async resolve(id: string, action: "overwrite" | "discard") {
    return this.commit(id, action);
  }
  async authorize(token: string) {
    this.http.authorize(token);
    let failure: unknown;
    try {
      const descriptor = await this.http.describe();
      if (!descriptor.capabilities.clientReplicaCommit)
        throw new VaultError(
          "Unsupported",
          "远端服务需要升级，以支持统一编辑器与预览。",
        );
      if (
        descriptor.vaultIdentity?.id !== this.descriptor.vaultIdentity?.id ||
        descriptor.vaultIdentity?.historyId !==
          this.descriptor.vaultIdentity?.historyId
      )
        throw new VaultError(
          "Conflict",
          "远端 Vault 历史已改变，旧会话正文仍保留。请保留正文后重新打开连接。",
        );
      this.descriptor = descriptor;
      this.offline = false;
    } catch (error) {
      this.offline = true;
      failure = error;
    }
    for (const host of this.hosts.values()) {
      const current = await this.execute<CoreDocument>("read", { id: host.id });
      this.publish(
        await this.hostState(
          host,
          failure instanceof Error ? failure.message : current.error,
          current.conflict,
        ),
        true,
      );
    }
    if (failure) throw failure;
  }
  override async flush() {
    if (this.descriptor.readOnly) return;
    for (const host of this.hosts.values()) {
      const raw = await this.execute<CoreDocument>("read", { id: host.id });
      if (raw.deleted) continue;
      if (raw.snapshot.text !== raw.savedContent || raw.error) {
        const saved = await this.save(host.id);
        if (saved.error)
          throw new VaultError(
            saved.conflict ? "Conflict" : "IO",
            saved.error,
            saved.path,
          );
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
    }
  }
  private async performFileOperation(
    method: string,
    p: Record<string, unknown>,
  ): Promise<unknown> {
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
    for (const host of affected) {
      const document = await this.http.documentRequest<CoreDocument>(
        this.route(host.id),
      );
      const packet = await this.http.documentRequest<SyncPacket>(
        this.route(host.id) + "/snapshot",
      );
      await this.receive({ document, packet });
    }
  }
  override async close() {
    await this.flush();
    await super.close();
  }
}
