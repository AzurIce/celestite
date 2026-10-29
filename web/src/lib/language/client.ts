import { ChangeSet, Text } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { setDiagnostics, type Diagnostic } from "@codemirror/lint";
import {
  LSPClient,
  LSPPlugin,
  Workspace,
  hoverTooltips,
  jumpToDefinition,
  serverDiagnostics,
  type Transport,
  type WorkspaceFile,
} from "@codemirror/lsp-client";
import type { EditorDocument, EditorDocuments } from "../editor/contract";
import { minimalChange } from "../editor/view-changes";
import { compositionState } from "../editor/composition";

const rootUri = "file:///vault";

/** Wire URIs stay raw; only vault URIs map to editable paths. */
export function languagePath(uri: string): string | null {
  return uri.startsWith(rootUri + "/") ? uri.slice(rootUri.length + 1) : null;
}

export function notistLanguageId(path: string): string | null {
  const name = path.split("/").pop()!;
  if (name === "Notist.toml") return "notist";
  const extension = name.split(".").pop();
  if (extension === "not" || extension === "notc") return "notist";
  return ["md", "markdown", "nmd", "notmd"].includes(extension ?? "")
    ? "markdown"
    : null;
}

export interface LanguagePosition {
  line: number;
  character: number;
}
export interface LanguageSymbol {
  name: string;
  detail?: string;
  selectionRange: { start: LanguagePosition; end: LanguagePosition };
  children?: LanguageSymbol[];
}
interface PublishDiagnostics {
  uri: string;
  version?: number | null;
  diagnostics: {
    range: { start: LanguagePosition; end: LanguagePosition };
    severity?: number;
    message: string;
  }[];
}

function toSeverity(severity: number): Diagnostic["severity"] {
  return severity === 1
    ? "error"
    : severity === 2
      ? "warning"
      : severity === 4
        ? "hint"
        : "info";
}

class VaultWorkspaceFile implements WorkspaceFile {
  view: EditorView | null = null;
  diagnostics?: PublishDiagnostics;
  source: Text;
  doc: Text;
  constructor(
    readonly uri: string,
    readonly languageId: string,
    public version: number,
    public content: string,
  ) {
    this.doc = this.source = Text.of(content.split("\n"));
  }
  getView() {
    return this.view;
  }
}

/** Open document lifetime belongs to EditorDocuments; views only attach for display. */
export class VaultWorkspace extends Workspace {
  files: VaultWorkspaceFile[] = [];
  private ready = false;
  private fileVersions: Record<string, number> = Object.create(null);
  private mountWaiters = new Map<
    string,
    {
      resolve: (view: EditorView | null) => void;
      timer: ReturnType<typeof setTimeout>;
    }[]
  >();
  constructor(
    client: LSPClient,
    private openInEditor: (path: string) => Promise<EditorView | null>,
  ) {
    super(client);
  }
  private nextFileVersion(uri: string) {
    return (this.fileVersions[uri] = (this.fileVersions[uri] ?? -1) + 1);
  }
  override connected() {
    // LSPClient.notification() has no rejection handler while initialize is
    // pending. Open the latest snapshots only after initialization succeeds.
    this.ready = false;
  }
  override disconnected() {
    this.ready = false;
  }
  initialized() {
    this.ready = true;
    this.syncFiles();
    for (const file of this.files) this.client.didOpen(file);
  }
  getFile(uri: string): VaultWorkspaceFile | null {
    return this.files.find((file) => file.uri === uri) ?? null;
  }
  updateDocuments(documents: readonly EditorDocument[]) {
    const sources = new Map<string, { languageId: string; content: string }>(
      documents.flatMap((document) => {
        const languageId = notistLanguageId(document.path);
        return languageId && !document.deleted && document.canPreview
          ? [
              [
                `${rootUri}/${document.path}`,
                { languageId, content: document.content },
              ] as const,
            ]
          : [];
      }),
    );
    const changed =
      sources.size !== this.files.length ||
      [...sources].some(([uri, source]) => {
        const file = this.getFile(uri);
        return !file || file.content !== source.content;
      });
    if (!changed) return false;
    for (const file of this.files) {
      if (!sources.has(file.uri) && this.ready) this.client.didClose(file.uri);
    }
    this.files = this.files.filter((file) => sources.has(file.uri));
    for (const [uri, source] of sources) {
      const file = this.getFile(uri);
      if (file) {
        if (file.content !== source.content) {
          file.content = source.content;
          file.source = Text.of(source.content.split("\n"));
        }
      } else {
        const opened = new VaultWorkspaceFile(
          uri,
          source.languageId,
          this.nextFileVersion(uri),
          source.content,
        );
        this.files.push(opened);
        if (this.ready) this.client.didOpen(opened);
      }
    }
    if (this.ready) this.client.sync();
    return changed;
  }
  syncFiles() {
    if (!this.ready) return [];
    const result: { file: WorkspaceFile; prevDoc: Text; changes: ChangeSet }[] =
      [];
    for (const file of this.files) {
      if (!file.doc.eq(file.source)) {
        const changes = ChangeSet.of(
          minimalChange(file.doc.toString(), file.source.toString()),
          file.doc.length,
        );
        result.push({ file, prevDoc: file.doc, changes });
        file.doc = file.source;
        file.version = this.nextFileVersion(file.uri);
        file.diagnostics = undefined;
      }
      const view = file.view;
      const plugin = view && LSPPlugin.get(view);
      if (view && plugin) {
        // Snapshot delivery can precede the reactive view update. Preserve the
        // exact mapping from the synchronized source to the current view.
        plugin.syncedDoc = file.doc;
        plugin.unsyncedChanges = ChangeSet.of(
          minimalChange(file.doc.toString(), view.state.doc.toString()),
          file.doc.length,
        );
      }
    }
    return result;
  }
  openFile(uri: string, _languageId: string, view: EditorView) {
    const file = this.getFile(uri);
    if (!file) return;
    file.view = view;
    const waiters = this.mountWaiters.get(uri);
    if (waiters) {
      this.mountWaiters.delete(uri);
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.resolve(view);
      }
    }
    // The LSPPlugin is still being constructed in openFile().
    queueMicrotask(() => {
      if (this.getFile(uri) === file && file.view === view)
        this.showDiagnostics(file);
    });
  }
  closeFile(uri: string, view: EditorView) {
    const file = this.getFile(uri);
    if (file?.view === view) file.view = null;
  }
  publishDiagnostics(params: PublishDiagnostics) {
    if (!this.ready) return;
    const file = this.getFile(params.uri);
    if (!file || params.version !== file.version) return;
    file.diagnostics = params;
    this.showDiagnostics(file);
  }
  resumeDiagnostics(view: EditorView) {
    const plugin = LSPPlugin.get(view);
    if (!this.ready || plugin?.client !== this.client) return;
    const file = this.getFile(plugin.uri);
    if (file?.view === view) this.showDiagnostics(file);
  }
  private showDiagnostics(file: VaultWorkspaceFile) {
    const view = file.view;
    const plugin = view && LSPPlugin.get(view);
    if (
      !view ||
      !plugin ||
      plugin.client !== this.client ||
      view.state.field(compositionState, false) ||
      (file.diagnostics && file.diagnostics.version !== file.version)
    )
      return;
    const mapping = ChangeSet.of(
      minimalChange(file.doc.toString(), view.state.doc.toString()),
      file.doc.length,
    );
    view.dispatch(
      setDiagnostics(
        view.state,
        (file.diagnostics?.diagnostics ?? []).map((item) => ({
          from: mapping.mapPos(plugin.fromPosition(item.range.start, file.doc)),
          to: mapping.mapPos(plugin.fromPosition(item.range.end, file.doc)),
          severity: toSeverity(item.severity ?? 1),
          message: item.message,
        })),
      ),
    );
  }
  viewFor(uri: string) {
    return this.getFile(uri)?.getView() ?? null;
  }
  waitForView(uri: string, timeout: number): Promise<EditorView | null> {
    const open = this.viewFor(uri);
    if (open) return Promise.resolve(open);
    return new Promise((resolve) => {
      const waiter = {
        resolve,
        timer: setTimeout(() => {
          const waiters = this.mountWaiters.get(uri);
          if (waiters?.includes(waiter)) {
            const remaining = waiters.filter((other) => other !== waiter);
            if (remaining.length) this.mountWaiters.set(uri, remaining);
            else this.mountWaiters.delete(uri);
            resolve(this.viewFor(uri));
          }
        }, timeout),
      };
      const waiters = this.mountWaiters.get(uri) ?? [];
      waiters.push(waiter);
      this.mountWaiters.set(uri, waiters);
    });
  }
  async displayFile(uri: string): Promise<EditorView | null> {
    const open = this.viewFor(uri);
    if (open) return open;
    const path = languagePath(uri);
    return path === null ? null : this.openInEditor(path);
  }
  dispose() {
    for (const waiters of this.mountWaiters.values()) {
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.resolve(null);
      }
    }
    this.mountWaiters.clear();
    this.files = [];
    this.ready = false;
  }
}

export function createNotistLanguageClient(
  documents: EditorDocuments,
  openInEditor: (path: string) => Promise<EditorView | null>,
): { client: LSPClient; workspace: VaultWorkspace; dispose(): void } | null {
  const channel = documents.language;
  if (!channel) return null;
  let unsubscribe: (() => void) | undefined;
  let disposed = false;
  let initializeFailed = false;
  let generation = 0;
  const transport: Transport = {
    send: (message) => {
      if (!disposed) channel.send(message);
    },
    subscribe: (handler) => {
      unsubscribe = channel.subscribe(handler);
    },
    unsubscribe: () => {
      unsubscribe?.();
      unsubscribe = undefined;
    },
  };
  const client = new LSPClient({
    rootUri,
    timeout: 15000,
    workspace: (owner) => new VaultWorkspace(owner, openInEditor),
    // FacetProvider values aren't recognized by LSPClient's extension detector.
    // Wrap the explicit F12 keymap, and enable only supported server features.
    extensions: [
      hoverTooltips(),
      {
        editorExtension: [
          keymap.of([
            {
              key: "F12",
              preventDefault: true,
              run: (view) => {
                if (initializeFailed) {
                  client.disconnect();
                  connect();
                }
                // Take the cursor and mapping after initialization, since source
                // snapshots may keep changing while the server starts.
                void client.initializing.then(
                  () => {
                    if (!disposed && LSPPlugin.get(view)?.client === client)
                      jumpToDefinition(view);
                  },
                  (error) => {
                    if (!disposed)
                      LSPPlugin.get(view)?.reportError("跳转到定义失败", error);
                  },
                );
                return true;
              },
            },
          ]),
          EditorView.updateListener.of((update) => {
            if (
              update.startState.field(compositionState, false) &&
              !update.state.field(compositionState, false)
            )
              queueMicrotask(() =>
                (client.workspace as VaultWorkspace).resumeDiagnostics(
                  update.view,
                ),
              );
          }),
        ],
      },
      serverDiagnostics(),
    ],
    notificationHandlers: {
      "textDocument/publishDiagnostics": (
        target,
        params: PublishDiagnostics,
      ) => {
        (target.workspace as VaultWorkspace).publishDiagnostics(params);
        return true;
      },
    },
  });
  const workspace = client.workspace as VaultWorkspace;
  const connect = () => {
    const attempt = ++generation;
    initializeFailed = false;
    client.connect(transport);
    void client.initializing.then(
      () => {
        if (!disposed && attempt === generation) workspace.initialized();
      },
      () => {
        if (!disposed && attempt === generation) initializeFailed = true;
      },
    );
  };
  workspace.updateDocuments(documents.snapshot().documents);
  connect();
  const detachDocuments = documents.subscribe((snapshot) => {
    if (disposed) return;
    const changed = workspace.updateDocuments(snapshot.documents);
    if (initializeFailed && changed) {
      client.disconnect();
      connect();
    }
  });
  return {
    client,
    workspace,
    dispose() {
      if (disposed) return;
      detachDocuments();
      // Send directly before disabling this transport, because the client's
      // notification helper schedules sends after the initialization promise.
      for (const file of workspace.files)
        channel.send(
          JSON.stringify({
            jsonrpc: "2.0",
            method: "textDocument/didClose",
            params: { textDocument: { uri: file.uri } },
          }),
        );
      disposed = true;
      client.disconnect();
      workspace.dispose();
      unsubscribe?.();
      unsubscribe = undefined;
    },
  };
}
