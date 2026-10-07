import { ChangeSet } from "@codemirror/state";
import { VaultError } from "../../vault/errors";
import { vaultPath, type VaultPath } from "../../vault/path";
import type { VaultBackend } from "../../vault/types";
import { decodeError, encodeError } from "../rpc";
import {
  callCore,
  coreValue,
  type CoreDocument,
  type CoreMutation,
  type CorePort,
  type CoreReply,
} from "../core";
import { restoredSelection } from "../commands";
import { editsOf, sameVersion } from "../view-changes";
import type {
  PackageResourceProvider,
  PreviewCoreMethods,
} from "../preview/contract";
import { PreviewResources } from "../preview/resources";
import type {
  BufferCommand,
  ConnectionState,
  MutationResult,
  ServiceDocument,
  ServiceEvent,
  Version,
  UndoContext,
} from "../contract";

interface Patch {
  before: Version;
  after: Version;
  changes: ChangeSet;
}

/** Worker transport, view projections and timers; Rust owns all editor policy. */
export class EditorHost {
  readonly previewResources: PreviewResources;
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private previews = new Map<string, ServiceDocument>();
  private eventSequence = 0;
  private patches = new Map<string, Patch[]>();
  constructor(
    protected core: CorePort,
    protected backend: VaultBackend,
    private emit: (event: ServiceEvent) => void,
    private schedule: (task: () => Promise<unknown>) => void,
    packages?: PackageResourceProvider,
  ) {
    this.previewResources = new PreviewResources(backend, packages);
  }
  private async invoke(
    method: string,
    params: Record<string, unknown> = {},
    replyFor?: string,
  ): Promise<CoreReply> {
    const reply = await callCore(this.core, method, params);
    // Effects are delivered even when a save/refresh ends in an IO error.
    for (const mutation of reply.mutations)
      await this.onMutation(mutation, mutation.document.id === replyFor);
    return reply;
  }
  protected async execute<T>(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    return coreValue<T>(await this.invoke(method, params));
  }
  protected clearPatches() {
    this.patches.clear();
  }
  protected ensureMutationAllowed() {}
  protected async onMutation(mutation: CoreMutation, inReply = false) {
    const { document, update } = mutation;
    const textChanged = !sameVersion(update.before, update.after);
    if (textChanged) {
      const patches = this.patches.get(document.id) ?? [];
      patches.push({
        before: update.before,
        after: update.after,
        changes: ChangeSet.of(update.edits, update.beforeLen),
      });
      if (patches.length > 128) patches.shift();
      this.patches.set(document.id, patches);
    }
    // A UI command carries its display edits in its reply. External updates
    // carry theirs in the event. Both come from the same Buffer result.
    const external = !inReply && textChanged;
    this.publish(
      document,
      external,
      external ? { before: update.before, edits: update.edits } : undefined,
      true,
    );
  }
  private rebase(command: BufferCommand, current: CoreDocument): BufferCommand {
    if (
      !("base" in command) ||
      sameVersion(command.base, current.snapshot.version)
    )
      return command;
    if (command.kind === "edit" && command.input.kind === "text")
      throw new VaultError(
        "Conflict",
        "全文替换的历史版本已过期。",
        current.path,
      );
    let version = command.base;
    let context: UndoContext =
      command.kind === "edit" ? command.undo : command.context;
    let changes: ChangeSet | undefined;
    for (const patch of this.patches.get(current.id) ?? []) {
      if (!sameVersion(version, patch.before)) continue;
      if (command.kind === "edit" && command.input.kind === "edits") {
        changes ??= ChangeSet.of(command.input.edits, patch.changes.length);
        changes = changes.map(patch.changes, true);
      }
      context = {
        ...context,
        positions: context.positions.map((position) =>
          patch.changes.mapPos(position),
        ),
      };
      version = patch.after;
    }
    if (!sameVersion(version, current.snapshot.version))
      throw new VaultError(
        "Conflict",
        "输入的历史版本已过期，输入仍保留。",
        current.path,
      );
    return command.kind === "edit"
      ? {
          ...command,
          base: version,
          undo: context,
          input: changes
            ? { kind: "edits", edits: editsOf(changes) }
            : command.input,
        }
      : { ...command, base: version, context };
  }
  async apply(id: string, command: BufferCommand): Promise<MutationResult> {
    this.ensureMutationAllowed();
    try {
      command = this.rebase(
        command,
        await this.execute<CoreDocument>("read", { id }),
      );
    } catch (error) {
      return this.rejectedMutation(id, error);
    }
    // Publishing/transmitting an accepted update may fail. Such failures are
    // never reclassified as rejected input just because their error code matches.
    const reply = await this.invoke("apply", { id, command }, id);
    if (reply.status === "error")
      return this.rejectedMutation(id, decodeError(reply.error));
    const mutation = reply.mutations.find((value) => value.document.id === id);
    if (!mutation) throw new VaultError("IO", "编辑命令缺少 Buffer 回执。", id);
    const selection = restoredSelection(mutation.update.restored);
    return {
      document: this.document(mutation.document),
      edits: mutation.update.edits,
      ...(selection ? { restoredSelection: selection } : {}),
    };
  }
  executePreview<K extends keyof PreviewCoreMethods>(
    method: K,
    params: PreviewCoreMethods[K]["params"],
  ): Promise<PreviewCoreMethods[K]["result"]> {
    return this.execute(method, params);
  }
  protected document(raw: CoreDocument, content = true): ServiceDocument {
    return {
      id: raw.id,
      path: vaultPath(raw.path),
      deleted: raw.deleted,
      savedContent: raw.savedContent,
      ...(content ? { content: raw.snapshot.text } : {}),
      bom: raw.bom,
      lineEnding: raw.lineEnding,
      readOnlyReason: null,
      canPreview: true,

      error: raw.error,
      externalChange: raw.externalChange,
      conflict: raw.conflict,
      core: {
        version: raw.snapshot.version,
        durableVersion: raw.durableVersion,
        undo: raw.undo,
        writerId: raw.writerId,
        historyError: raw.persistenceError,
      },
    };
  }
  protected publish(
    raw: CoreDocument,
    content = false,
    change?: ServiceDocument["change"],
    includeDeleted = false,
  ) {
    clearTimeout(this.timers.get(raw.id));
    this.timers.delete(raw.id);
    if (raw.deleted && !includeDeleted) return;
    if (raw.autosaveDelay !== null) {
      this.timers.set(
        raw.id,
        setTimeout(() => {
          this.timers.delete(raw.id);
          this.schedule(() => this.save(raw.id));
        }, raw.autosaveDelay),
      );
    }
    this.emit({
      kind: "document",
      sequence: ++this.eventSequence,
      document: {
        ...this.document(raw, content),
        ...(change ? { change } : {}),
      },
    });
  }
  protected publishConnection(connection: ConnectionState) {
    this.emit({
      kind: "connection",
      sequence: ++this.eventSequence,
      connection,
    });
  }
  protected publishTree() {
    this.emit({ kind: "tree", sequence: ++this.eventSequence });
  }
  protected async refreshViews(content = true) {
    for (const raw of await this.execute<CoreDocument[]>("resident"))
      this.publish(raw, content);
  }
  async composition(_id: string, _active: boolean) {}
  async open(path: VaultPath): Promise<ServiceDocument> {
    try {
      const raw = await this.execute<CoreDocument>("open", { path });
      this.publish(raw);
      return this.document(raw);
    } catch (error) {
      if (!(error instanceof VaultError) || error.code !== "Unsupported")
        throw error;
      const preview: ServiceDocument = {
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
      this.previews.set(preview.id, preview);
      return preview;
    }
  }
  async read(id: string): Promise<ServiceDocument> {
    return this.document(await this.execute<CoreDocument>("read", { id }));
  }
  protected async rejectedMutation(
    id: string,
    error: unknown,
  ): Promise<MutationResult> {
    // Called only before apply or for its explicit error reply. Acceptance is
    // determined by the core contract, not an adapter-maintained error-code list.
    return {
      document: await this.read(id),
      edits: [],
      rejection: encodeError(error),
    };
  }
  async retryHistory(id: string) {
    const raw = await this.execute<CoreDocument>("retry_history", { id });
    await this.refreshViews(false);
    return this.document(raw);
  }
  async retryObservation(id: string) {
    const raw = await this.execute<CoreDocument>("retry_observation", { id });
    this.publish(raw);
    return this.document(raw);
  }
  async save(id: string) {
    const preview = this.previews.get(id);
    if (preview) return preview;
    const raw = await this.execute<CoreDocument>("save", { id });
    this.publish(raw);
    return this.document(raw);
  }
  async resolve(id: string, action: "overwrite" | "discard" | "retry") {
    if (action === "retry")
      throw new VaultError(
        "Unsupported",
        "本地保存冲突需要选择覆盖或丢弃。",
        id,
      );
    try {
      const raw = await this.execute<CoreDocument>("resolve", { id, action });
      this.publish(raw, true);
      return this.document(raw);
    } catch (error) {
      await this.refreshViews(false);
      throw error;
    }
  }
  async flush() {
    try {
      await this.execute("flush");
    } finally {
      await this.refreshViews(false);
    }
  }
  async fileOperation(
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    let result: unknown;
    try {
      result = await this.execute("file", {
        ...params,
        method,
        ...(params.data instanceof Uint8Array
          ? { data: Array.from(params.data) }
          : {}),
      });
    } finally {
      if (["writeFile", "mkdir", "rename", "remove"].includes(method))
        await this.executePreview("preview_invalidate_project", {});
      await this.refreshViews();
    }
    if (method === "readFile") return new Uint8Array(result as number[]);
    if (method === "readFileSnapshot") {
      const file = result as { data: number[]; revision: string };
      return { data: new Uint8Array(file.data), revision: file.revision };
    }
    return result;
  }
  async close() {
    await this.execute("close");
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    await this.backend.close();
  }
}
