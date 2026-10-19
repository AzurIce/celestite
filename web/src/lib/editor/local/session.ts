import { EditorSession } from "../runtime/session";
import type { CoreDocument, CorePort } from "../core";
import { fileAffectsText } from "../files";
import { VaultError } from "../../vault/errors";
import type { VaultBackend } from "../../vault/types";
import type { VaultPath } from "../../vault/path";
import type {
  CollaborationSnapshot,
  ServiceDocument,
  ServiceEvent,
  VersionedSelection,
} from "../contract";

/** A file owner coordinates persistence, observation and local view ordering. */
export class LocalEditorSession extends EditorSession {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private recoveryDeadlines = new Map<string, number>();
  private recoveryTimer: ReturnType<typeof setTimeout> | undefined;
  private recoveryDeadline: number | null = null;
  private recoveryQueued = false;
  private checkpoints = 0;
  private recoveryError: string | null = null;
  private disposed = false;
  private placeholders = new Map<string, ServiceDocument>();
  private composing = new Set<string>();
  constructor(
    core: CorePort,
    private backend: VaultBackend,
    emit: (event: ServiceEvent) => void,
    private schedule: (task: () => Promise<unknown>) => void,
    private observeExternal = false,
  ) {
    super(core, emit);
  }
  collaboration(): CollaborationSnapshot | null {
    return null;
  }
  async setView(
    _viewId: string,
    _documentId: string | null,
    _focused: boolean,
    _selection: VersionedSelection | null = null,
  ) {}
  protected override publish(
    raw: CoreDocument,
    content = false,
    change?: ServiceDocument["change"],
  ) {
    if (this.disposed) return;
    clearTimeout(this.timers.get(raw.id));
    this.timers.delete(raw.id);
    this.recoveryError = raw.recoveryError;
    if (raw.recoveryDelay === null) this.recoveryDeadlines.delete(raw.id);
    else this.recoveryDeadlines.set(raw.id, Date.now() + raw.recoveryDelay);
    this.scheduleRecovery();
    if (raw.autosaveDelay !== null) {
      this.timers.set(
        raw.id,
        setTimeout(() => {
          this.timers.delete(raw.id);
          this.schedule(async () => {
            try {
              await this.save(raw.id);
            } catch {
              this.publish(
                await this.execute<CoreDocument>("read", { id: raw.id }),
                false,
              );
            }
          });
        }, raw.autosaveDelay),
      );
    }
    super.publish(raw, content, change);
  }
  private scheduleRecovery() {
    if (this.disposed || this.recoveryQueued || this.checkpoints > 0) return;
    const next = [...this.recoveryDeadlines].sort((a, b) => a[1] - b[1])[0];
    const deadline = next?.[1] ?? null;
    if (deadline === this.recoveryDeadline) return;
    clearTimeout(this.recoveryTimer);
    this.recoveryTimer = undefined;
    this.recoveryDeadline = deadline;
    if (!next) return;
    this.recoveryTimer = setTimeout(
      () => {
        this.recoveryTimer = undefined;
        this.recoveryDeadline = null;
        // Mark the whole-vault task before queueing it. Slow IO must not let
        // another document enqueue a second checkpoint of the same drafts.
        this.recoveryQueued = true;
        this.schedule(async () => {
          try {
            if (this.recoveryDeadlines.size === 0) return;
            // Checkpoint publishes failures and clears all attempted deadlines.
            await this.checkpoint(next[0]);
          } catch {
          } finally {
            this.recoveryQueued = false;
            this.scheduleRecovery();
          }
        });
      },
      Math.max(0, next[1] - Date.now()),
    );
  }
  private async refreshViews(exceptId?: string) {
    for (const raw of await this.execute<CoreDocument[]>("resident"))
      if (raw.id !== exceptId) this.publish(raw, false);
  }
  async releaseDocument(id: string) {
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
    this.placeholders.delete(id);
    this.composing.delete(id);
  }
  async composition(id: string, active: boolean) {
    if (active) this.composing.add(id);
    else {
      this.composing.delete(id);
      if (!this.placeholders.has(id))
        this.publish(await this.execute<CoreDocument>("read", { id }));
      if (this.observeExternal) await this.observeFiles();
    }
  }
  async observeFiles() {
    const recoveryError = this.recoveryError;
    const resident = await this.execute<CoreDocument[]>("resident");
    const documents = await this.execute<CoreDocument[]>("observe_files", {
      ids: resident
        .filter(
          (document) => !document.deleted && !this.composing.has(document.id),
        )
        .map((document) => document.id),
    });
    for (const document of documents) this.publish(document, false);
    if (
      recoveryError !== this.recoveryError ||
      documents.some(
        (document) => document.recoveryError !== this.recoveryError,
      )
    )
      await this.refreshViews();
    this.publishTree();
  }
  async open(path: VaultPath): Promise<ServiceDocument> {
    try {
      const recoveryError = this.recoveryError;
      const raw = await this.execute<CoreDocument>("open", { path });
      this.publish(raw);
      if (raw.recoveryError !== recoveryError) await this.refreshViews(raw.id);
      return this.document(raw);
    } catch (error) {
      await this.refreshViews();
      if (!(error instanceof VaultError) || error.code !== "Unsupported")
        throw error;
      const preview: ServiceDocument = {
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
      this.placeholders.set(preview.id, preview);
      return preview;
    }
  }
  async checkpoint(id: string) {
    this.checkpoints++;
    clearTimeout(this.recoveryTimer);
    this.recoveryTimer = undefined;
    this.recoveryDeadline = null;
    this.recoveryDeadlines.clear();
    try {
      await this.execute("checkpoint");
      return this.document(await this.execute<CoreDocument>("read", { id }));
    } finally {
      try {
        await this.refreshViews();
      } finally {
        this.checkpoints--;
        this.scheduleRecovery();
      }
    }
  }
  async retryObservation(id: string) {
    const recoveryError = this.recoveryError;
    try {
      const raw = await this.execute<CoreDocument>("retry_observation", { id });
      this.publish(raw);
      if (raw.recoveryError !== recoveryError) await this.refreshViews(id);
      return this.document(raw);
    } catch (error) {
      await this.refreshViews();
      throw error;
    }
  }
  async save(id: string) {
    if (this.composing.has(id))
      return {
        ...this.document(await this.execute<CoreDocument>("read", { id })),
        error: "请结束组合输入后保存。",
      };
    const preview = this.placeholders.get(id);
    if (preview) return preview;
    const recoveryError = this.recoveryError;
    try {
      const raw = await this.execute<CoreDocument>("save", { id });
      this.publish(raw);
      if (raw.recoveryError !== recoveryError) await this.refreshViews(id);
      return this.document(raw);
    } catch (error) {
      await this.refreshViews();
      throw error;
    }
  }
  async resolve(id: string, action: "overwrite" | "discard" | "retry") {
    if (action === "retry")
      throw new VaultError(
        "Unsupported",
        "本地保存冲突需要选择覆盖或丢弃。",
        id,
      );
    try {
      const recoveryError = this.recoveryError;
      const raw = await this.execute<CoreDocument>("resolve", { id, action });
      this.publish(raw, true);
      if (raw.recoveryError !== recoveryError) await this.refreshViews(id);
      return this.document(raw);
    } catch (error) {
      await this.refreshViews();
      throw error;
    }
  }
  async flush() {
    try {
      await this.execute("flush");
    } finally {
      await this.refreshViews();
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
      if (fileAffectsText(method)) await this.refreshViews();
    }
    if (method === "readFile") return new Uint8Array(result as number[]);
    if (method === "readFileSnapshot") {
      const file = result as { data: number[]; revision: string };
      return { data: new Uint8Array(file.data), revision: file.revision };
    }
    return result;
  }
  dispose() {
    this.disposed = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    clearTimeout(this.recoveryTimer);
    this.recoveryTimer = undefined;
    this.recoveryDeadline = null;
    this.recoveryDeadlines.clear();
  }
  async close() {
    try {
      await this.execute("close");
    } catch (error) {
      await this.refreshViews().catch(() => {});
      throw error;
    }
    this.dispose();
    await this.backend.close();
  }
}
