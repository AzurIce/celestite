import { VaultError } from "../vault/errors";
import { vaultPath, type VaultPath } from "../vault/path";
import type { VaultBackend } from "../vault/types";
import { decodeError } from "./rpc";
import type { PreviewCoreMethods } from "./preview-contract";
import type {
  EditResult,
  ServiceDocument,
  ServiceEvent,
  Version,
  SelectionContext,
  TextEdit,
  TextSnapshot,
  UndoState,
  RpcError,
} from "./contract";

export interface CorePort {
  execute(method: string, params: string): Promise<string>;
}
export interface CoreDocument {
  id: string;
  path: string;
  snapshot: TextSnapshot;
  undo: UndoState;
  writerId: string;
  savedContent: string;
  bom: boolean;
  lineEnding: ServiceDocument["lineEnding"];
  deleted: boolean;
  conflict: boolean;
  durableVersion: Version | null;
  persistenceError: string | null;
  error: string | null;
  autosaveDelay: number | null;
  backendRevision: string;
}
interface CoreEdit {
  document: CoreDocument;
  edits: TextEdit[];
  restoredSelection: SelectionContext | null;
}
/** Worker transport, view projections and timers; Rust owns all editor policy. */
export class OpfsEditorHost {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private previews = new Map<string, ServiceDocument>();
  private eventSequence = 0;
  constructor(
    protected core: CorePort,
    protected backend: VaultBackend,
    private emit: (event: ServiceEvent) => void,
    private schedule: (task: () => Promise<unknown>) => void,
  ) {}
  protected async execute<T>(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    try {
      return JSON.parse(
        await this.core.execute(method, JSON.stringify(params)),
      ) as T;
    } catch (error) {
      let decoded: RpcError;
      try {
        decoded = JSON.parse(String(error));
      } catch {
        throw error;
      }
      throw decodeError(decoded);
    }
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
      savedContent: raw.savedContent,
      ...(content ? { content: raw.snapshot.text } : {}),
      bom: raw.bom,
      lineEnding: raw.lineEnding,
      readOnlyReason: null,
      canPreview: true,
      saving: false,
      error: raw.error,
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
  protected publish(raw: CoreDocument, content = false) {
    clearTimeout(this.timers.get(raw.id));
    this.timers.delete(raw.id);
    if (raw.deleted) return;
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
      document: this.document(raw, content),
    });
  }
  protected async refreshViews(content = true) {
    for (const raw of await this.execute<CoreDocument[]>("resident"))
      this.publish(raw, content);
  }
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
        saving: false,
        error: null,
        conflict: false,
      };
      this.previews.set(preview.id, preview);
      return preview;
    }
  }
  async edit(
    id: string,
    version: Version,
    edits: TextEdit[],
    context: SelectionContext,
    userEvent: string,
  ): Promise<EditResult> {
    const result = await this.execute<CoreEdit>("edit", {
      id,
      version,
      edits,
      context,
      userEvent,
    });
    this.publish(result.document);
    return {
      document: this.document(result.document),
      edits: result.edits,
      ...(result.restoredSelection
        ? { restoredSelection: result.restoredSelection }
        : {}),
    };
  }
  async undo(
    id: string,
    context: SelectionContext,
    redo: boolean,
  ): Promise<EditResult> {
    const result = await this.execute<CoreEdit>("undo", { id, context, redo });
    this.publish(result.document);
    return {
      document: this.document(result.document),
      edits: result.edits,
      ...(result.restoredSelection
        ? { restoredSelection: result.restoredSelection }
        : {}),
    };
  }
  async retryHistory(id: string) {
    const raw = await this.execute<CoreDocument>("retry_history", { id });
    await this.refreshViews(false);
    return this.document(raw);
  }
  async save(id: string) {
    const preview = this.previews.get(id);
    if (preview) return preview;
    const raw = await this.execute<CoreDocument>("save", { id });
    this.publish(raw);
    return this.document(raw);
  }
  async resolve(id: string, action: "overwrite" | "discard") {
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
