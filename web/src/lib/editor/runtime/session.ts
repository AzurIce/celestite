import { ChangeSet } from "@codemirror/state";
import { VaultError } from "../../vault/errors";
import { vaultPath } from "../../vault/path";
import { encodeError } from "../rpc";
import {
  coreValue,
  type CoreDocument,
  type CoreMutation,
  type CorePort,
  type CoreReply,
} from "../core";
import { restoredSelection } from "../commands";
import { editsOf, sameVersion } from "../view-changes";
import type { DocumentSourceSnapshot } from "../generated/celestite_core";
import { TaskQueue } from "../queue";
import type {
  BufferCommand,
  ConnectionState,
  MutationResult,
  ServiceDocument,
  ServiceEvent,
  Version,
  UndoContext,
  CollaborationSnapshot,
  Affinity,
  Anchor,
} from "../contract";

interface Patch {
  before: Version;
  after: Version;
  changes: ChangeSet;
}

/** Shared core execution, view changes and projections for local owners and online replicas. */
export class EditorSession {
  protected eventSequence = 0;
  private patches = new Map<string, Patch[]>();
  constructor(
    protected core: CorePort,
    private emit: (event: ServiceEvent) => void,
  ) {}
  private coreQueue = new TaskQueue();
  private async call(
    method: string,
    params: Record<string, unknown> = {},
    replyFor?: string,
  ): Promise<CoreReply> {
    const reply = await this.core.call(method, params);
    for (const mutation of reply.mutations)
      this.onMutation(mutation, mutation.document.id === replyFor);
    return reply;
  }
  protected async execute<T>(
    method: string,
    params: Record<string, unknown> = {},
    lease?: { before(): void; accept(value: T): void },
  ): Promise<T> {
    return this.coreQueue.run(async () => {
      lease?.before();
      const value = coreValue<T>(await this.call(method, params));
      lease?.accept(value);
      return value;
    });
  }
  protected clearPatches() {
    this.patches.clear();
  }
  protected ensureMutationAllowed() {}
  protected onMutation(mutation: CoreMutation, inReply = false) {
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
    );
  }
  private rebase(command: BufferCommand, current: CoreDocument): BufferCommand {
    if (!("base" in command) || sameVersion(command.base, current.version))
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
    if (!sameVersion(version, current.version))
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
  apply(id: string, command: BufferCommand): Promise<MutationResult> {
    return this.coreQueue.run(async () => {
      this.ensureMutationAllowed();
      const current = coreValue<CoreDocument>(await this.call("read", { id }));
      try {
        command = this.rebase(command, current);
      } catch (error) {
        return {
          document: this.document(current),
          edits: [],
          rejection: encodeError(error),
        };
      }
      // Reading/rebasing and acceptance share one core lease. Detached network
      // completions cannot advance history between these two steps.
      const reply = await this.call("apply", { id, command }, id);
      if (reply.status === "error") {
        const document = coreValue<CoreDocument>(
          await this.call("read", { id }),
        );
        return {
          document: this.document(document),
          edits: [],
          rejection: reply.error,
        };
      }
      const mutation = reply.mutations.find(
        (value) => value.document.id === id,
      );
      if (!mutation)
        throw new VaultError("IO", "编辑命令缺少 Buffer 回执。", id);
      const selection = restoredSelection(mutation.update.restored);
      return {
        document: this.document(mutation.document),
        edits: mutation.update.edits,
        ...(selection ? { restoredSelection: selection } : {}),
      };
    });
  }
  readSource(ids: readonly string[]): Promise<DocumentSourceSnapshot> {
    return this.withSource(ids, (source) => source);
  }
  /** Consume a readonly capture and synchronize its controller under one core lease.
   * Rendering and resource IO use the owned snapshot after this lease. */
  withSource<T>(
    ids: readonly string[],
    consume: (source: DocumentSourceSnapshot) => T | Promise<T>,
  ): Promise<T> {
    return this.coreQueue.run(async () => {
      const source = coreValue<DocumentSourceSnapshot>(
        await this.call("document_source", { ids: [...ids] }),
      );
      return consume(source);
    });
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
        version: raw.version,
        undo: raw.undo,
        peerId: raw.peerId,
        recoveryError: raw.recoveryError,
      },
    };
  }
  protected publish(
    raw: CoreDocument,
    content = false,
    change?: ServiceDocument["change"],
  ) {
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
  protected publishMembers(state: CollaborationSnapshot | null) {
    this.emit({ kind: "members", sequence: ++this.eventSequence, state });
  }
  anchorsAt(
    id: string,
    version: Version,
    positions: [number, Affinity][],
  ): Promise<Anchor[]> {
    return this.execute("anchors_at", { id, version, positions });
  }
  resolveAnchors(
    id: string,
    checkpoint: Version,
    anchors: Anchor[],
  ): Promise<[Version, number[]]> {
    return this.execute("resolve_anchors", { id, checkpoint, anchors });
  }
  async read(id: string): Promise<ServiceDocument> {
    return this.document(await this.execute<CoreDocument>("read", { id }));
  }
}
