import { ChangeSet } from "@codemirror/state";
import { EditorHost, type CoreDocument } from "../runtime/host";
import { editsOf, sameVersion } from "../view-changes";
import type {
  EditResult,
  SelectionContext,
  ServiceDocument,
  TextEdit,
  Version,
} from "../contract";
import { VaultError } from "../../vault/errors";

interface Patch {
  before: Version;
  after: Version;
  changes: ChangeSet;
}

/** Disk observation uses the core bridge; this host carries view changes and IME ordering. */
export class DirectoryEditorHost extends EditorHost {
  private published = new Map<string, CoreDocument>();
  private changes = new WeakMap<
    CoreDocument,
    NonNullable<ServiceDocument["change"]>
  >();
  private patches = new Map<string, Patch[]>();
  private composing = new Set<string>();

  override async composition(id: string, active: boolean) {
    if (active) this.composing.add(id);
    else {
      this.composing.delete(id);
      await this.observeFiles();
    }
  }
  override async save(id: string) {
    if (this.composing.has(id))
      return {
        ...this.document(await super.execute<CoreDocument>("read", { id })),
        error: "请结束组合输入后保存。",
      };
    return super.save(id);
  }
  async observeFiles() {
    const resident = await super.execute<CoreDocument[]>("resident");
    const documents = await this.execute<CoreDocument[]>("observe_files", {
      ids: resident
        .filter(
          (document) => !document.deleted && !this.composing.has(document.id),
        )
        .map((document) => document.id),
    });
    for (const document of documents) this.publish(document, true);
    this.publishTree();
  }
  protected override async execute<T>(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    const result = await super.execute<T>(method, params);
    // Edits and undo have their own explicit view transaction. Only background
    // changes need rebasing and an incremental publication.
    if (method === "edit" || method === "undo") return result;
    const values = Array.isArray(result) ? result : [result];
    for (const value of values) {
      if (
        !value ||
        typeof value !== "object" ||
        !("snapshot" in value) ||
        !("id" in value)
      )
        continue;
      const raw = value as CoreDocument;
      const before = this.published.get(raw.id);
      if (!before || sameVersion(before.snapshot.version, raw.snapshot.version))
        continue;
      const edits = await super.execute<TextEdit[]>("text_changes", {
        before: before.snapshot.text,
        after: raw.snapshot.text,
      });
      this.changes.set(raw, { before: before.snapshot.text, edits });
    }
    return result;
  }
  protected override publish(raw: CoreDocument, content = false) {
    const change = this.changes.get(raw);
    const before = this.published.get(raw.id);
    if (change && before) {
      const patches = this.patches.get(raw.id) ?? [];
      patches.push({
        before: before.snapshot.version,
        after: raw.snapshot.version,
        changes: ChangeSet.of(change.edits, change.before.length),
      });
      if (patches.length > 128) patches.shift();
      this.patches.set(raw.id, patches);
    }
    this.published.set(raw.id, raw);
    super.publish(raw, content || !!change, change, true);
  }
  private rebase(
    id: string,
    version: Version,
    context: SelectionContext,
    edits?: TextEdit[],
  ) {
    let changes: ChangeSet | undefined;
    for (const patch of this.patches.get(id) ?? []) {
      if (!sameVersion(version, patch.before)) continue;
      if (edits) {
        changes ??= ChangeSet.of(edits, patch.changes.length);
        changes = changes.map(patch.changes, true);
      }
      context = {
        ...context,
        ranges: context.ranges.map((range) => ({
          anchor: patch.changes.mapPos(range.anchor),
          head: patch.changes.mapPos(range.head),
        })),
      };
      version = patch.after;
    }
    return { version, context, edits: changes ? editsOf(changes) : edits };
  }
  override async edit(
    id: string,
    version: Version,
    edits: TextEdit[],
    context: SelectionContext,
    userEvent: string,
  ): Promise<EditResult> {
    const current = await super.execute<CoreDocument>("read", { id });
    if (!sameVersion(version, current.snapshot.version)) {
      const mapped = this.rebase(id, version, context, edits);
      if (!sameVersion(mapped.version, current.snapshot.version))
        return this.rejectedEdit(
          id,
          new VaultError(
            "Conflict",
            "输入的历史版本已过期，输入仍保留。",
            current.path,
          ),
        );
      version = mapped.version;
      context = mapped.context;
      edits = mapped.edits!;
    }
    return super.edit(id, version, edits, context, userEvent);
  }
  override async undo(
    id: string,
    context: SelectionContext,
    redo: boolean,
    version?: Version,
  ): Promise<EditResult> {
    if (version) {
      const current = await super.execute<CoreDocument>("read", { id });
      const mapped = this.rebase(id, version, context);
      if (!sameVersion(mapped.version, current.snapshot.version))
        throw new VaultError(
          "Conflict",
          "撤销选区的历史版本已过期，正文仍保留。",
          current.path,
        );
      context = mapped.context;
    }
    return super.undo(id, context, redo, version);
  }
}
