import { EditorHost } from "../runtime/host";
import type { CoreDocument } from "../core";

/** Disk observation uses the core bridge; this host carries view changes and IME ordering. */
export class DirectoryEditorHost extends EditorHost {
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
    for (const document of documents)
      this.publish(document, false, undefined, true);
    this.publishTree();
  }
}
