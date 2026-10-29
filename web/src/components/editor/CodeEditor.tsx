import {
  createEffect,
  createSignal,
  onCleanup,
  onSettled,
  Show,
  untrack,
} from "solid-js";
import {
  Annotation,
  Compartment,
  EditorSelection,
  EditorState,
  Prec,
  Transaction,
} from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { diagnosticCount, setDiagnostics } from "@codemirror/lint";
import { sourceExtensions } from "./source-extensions";
import type {
  EditorDocument,
  ViewEdit,
  SelectionContext,
  ViewSelection,
} from "@/lib/editor/contract";
import { languageSupport } from "./languages";
import { livePreview } from "./live-preview";
import {
  compositionState,
  editorComposition,
  setComposing,
} from "../../lib/editor/composition";
import { notistLanguageId } from "@/lib/language/client";
import type { LSPClient } from "@codemirror/lsp-client";
import { vimExtension, vimNormalMode, vimUserEvent, type VimMode } from "./vim";
import "./editor.css";
import "./live-preview.css";
import { collaboratorField, setCollaborators } from "./collaborators";

import type { EditorBuffer } from "./buffer";
import type { PreviewSync } from "./preview-sync";
interface CodeEditorProps {
  activation: number;
  previewSync?: PreviewSync;
  lspClient?: LSPClient;
  reveal?: { from: number; to: number; requestId: string };
  document: EditorDocument;
  onTransaction: (transaction: ViewEdit) => boolean;
  onComposition?: (active: boolean) => void;
  onView?: (
    viewId: string,
    documentId: string | null,
    focused: boolean,
    selection?: ViewSelection,
  ) => void;
  onUndo: (context: SelectionContext, redo: boolean) => void;
  wrap: boolean;
  live: boolean;
  vim: boolean;
  cached?: EditorBuffer;
  onSave: () => void;
  onClose: () => void;
  onVimMode: (mode: VimMode | null) => void;
  onCursor: (line: number, column: number) => void;
  onCache: (buffer: EditorBuffer) => void;
}
import { minimalChange } from "@/lib/editor/view-changes";
const serviceUpdate = Annotation.define<boolean>();
const selectionContext = (state: EditorState): SelectionContext => ({
  ranges: state.selection.ranges.map(({ anchor, head }) => ({ anchor, head })),
  mainIndex: state.selection.mainIndex,
});

export default function CodeEditor(props: CodeEditorProps) {
  const previewSync = untrack(() => props.previewSync);
  const documentId = untrack(() => props.document.id);
  const viewId = crypto.randomUUID();
  let detachPreviewSync: (() => void) | undefined;
  let host!: HTMLDivElement;
  let view: EditorView | undefined;
  let projectionContent = "";
  let buffer: EditorBuffer;
  let disposed = false;
  let languageRequest = 0;
  let languagePath: string | undefined;
  let selectionRevision = 0;
  let configuredLsp:
    | { client: LSPClient | undefined; path: string; languageId: string | null }
    | undefined;
  let configuredLive: boolean | undefined;
  let configuredWrap: boolean | undefined;
  let lastActivation = untrack(() => props.activation);
  let observer: MutationObserver | undefined;
  const [languageError, setLanguageError] = createSignal(false);
  const darkTheme = () =>
    EditorView.theme(
      {},
      { dark: document.documentElement.dataset.theme === "dark" },
    );
  const cursor = (state: EditorState) => {
    const head = state.selection.main.head;
    const line = state.doc.lineAt(head);
    props.onCursor(line.number, head - line.from + 1);
  };
  const reportView = () => {
    if (!view || disposed) return;
    props.onView?.(
      viewId,
      documentId,
      view.hasFocus && !document.hidden && document.hasFocus(),
      { content: projectionContent, selection: selectionContext(view.state) },
    );
  };
  const undo = (redo: boolean) => (editor: EditorView) => {
    if (!props.document.readOnlyReason)
      props.onUndo(selectionContext(editor.state), redo);
    return true;
  };
  const applyCollaborators = () => {
    if (
      !view ||
      disposed ||
      view.state.field(compositionState, false) ||
      projectionContent !== props.document.content
    )
      return;
    view.dispatch({
      effects: setCollaborators.of(props.document.collaborators ?? []),
    });
  };
  const bindings = () => [
    collaboratorField,
    Prec.highest(
      keymap.of([
        { key: "Mod-z", run: undo(false), shift: undo(true) },
        { key: "Mod-y", run: undo(true) },
        {
          key: "Mod-s",
          run: () => {
            props.onSave();
            return true;
          },
        },
      ]),
    ),
    // Keep focus during a core command round-trip, but reject text input until
    // the host has returned the new version. Toggling contenteditable here would
    // blur the view and swallow a following redo keyboard shortcut.
    EditorState.transactionFilter.of((transaction) =>
      transaction.docChanged &&
      !transaction.annotation(serviceUpdate) &&
      (props.document.locked || props.document.readOnlyReason)
        ? []
        : transaction,
    ),
    editorComposition((active) => {
      props.onComposition?.(active);
      if (!active) queueMicrotask(applyCollaborators);
    }),
    EditorView.contentAttributes.of({
      "aria-label": "代码编辑器",
      spellcheck: "false",
      autocapitalize: "off",
      autocorrect: "off",
    }),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) projectionContent = update.state.doc.toString();
      if (update.docChanged) previewSync?.invalidateEditor(update.view);
      if (update.geometryChanged || update.viewportChanged)
        previewSync?.editorLayoutChanged(update.view);
      if (
        update.docChanged &&
        !update.transactions.some((transaction) =>
          transaction.annotation(serviceUpdate),
        )
      ) {
        const content = projectionContent;
        const edits: ViewEdit["edits"] = [];
        update.changes.iterChanges((from, to, _fromB, _toB, insert) =>
          edits.push({ from, to, insert: insert.toString() }),
        );
        const accepted = props.onTransaction({
          edits,
          content,
          before: selectionContext(update.startState),
          after: selectionContext(update.state),
          userEvent:
            vimUserEvent(update.view) ??
            update.transactions
              .map((transaction) =>
                transaction.annotation(Transaction.userEvent),
              )
              .find(Boolean) ??
            "view",
        });
        if (!accepted)
          queueMicrotask(() => {
            if (!disposed && view)
              view.dispatch({
                changes: {
                  from: 0,
                  to: view.state.doc.length,
                  insert: props.document.content,
                },
                annotations: [
                  serviceUpdate.of(true),
                  Transaction.addToHistory.of(false),
                ],
              });
          });
      }
      if (update.docChanged || update.selectionSet) cursor(update.state);
      if (update.docChanged || update.selectionSet || update.focusChanged)
        reportView();
    }),
  ];
  const readOnly = () =>
    props.document.locked || !!props.document.readOnlyReason;
  const acceptsInput = () =>
    (!props.document.locked || !!props.document.core) &&
    !props.document.inputFailure &&
    !props.document.readOnlyReason;
  const editable = () => [
    EditorState.readOnly.of(readOnly()),
    EditorView.editable.of(acceptsInput()),
  ];
  const vimBindings = () =>
    props.vim
      ? vimExtension({
          save: () => props.onSave(),
          close: () => props.onClose(),
          unsaved: () =>
            !!(
              props.document.dirty ||
              props.document.pending ||
              props.document.saving ||
              props.document.core?.recoveryError
            ),
          undo: (redo) => {
            if (view) undo(redo)(view);
          },
          onMode: (mode) => props.onVimMode(mode),
        })
      : [];
  async function configureLanguage(path: string) {
    // Document metadata is republished during disk checks. Keep the parser and
    // its decorations when the file's language selection has not changed.
    if (path === languagePath) return;
    languagePath = path;
    const request = ++languageRequest;
    setLanguageError(false);
    try {
      const extension = await languageSupport(path, () => {
        if (!disposed && request === languageRequest) setLanguageError(true);
      });
      if (!disposed && request === languageRequest && view)
        view.dispatch({ effects: buffer.language.reconfigure(extension) });
    } catch {
      if (!disposed && request === languageRequest) setLanguageError(true);
    }
  }
  function configureLsp(path: string) {
    if (!view || disposed) return;
    const client = props.lspClient;
    const languageId =
      client && !props.document.deleted ? notistLanguageId(path) : null;
    if (
      configuredLsp?.client === client &&
      configuredLsp?.path === path &&
      configuredLsp?.languageId === languageId
    )
      return;
    configuredLsp = { client, path, languageId };
    if (diagnosticCount(view.state))
      view.dispatch(setDiagnostics(view.state, []));
    view.dispatch({
      effects: buffer.lsp.reconfigure(
        client && languageId
          ? client.plugin(`file:///vault/${path}`, languageId)
          : [],
      ),
    });
  }
  /**
   * 打开文件时把焦点交给编辑器（与 Zed 一致）。读取是异步的，视图挂载可能
   * 晚于用户已经开始的下一步操作；只有焦点仍留在文件树、编辑器内或文档
   * 空白处时才抢焦点，避免把用户在对话框/输入框里的操作打断。
   */
  function focusIfIdle() {
    const active = document.activeElement;
    // A lazy mount may finish after the user has moved to a toolbar or menu.
    // Only document navigation and the editor itself hand focus to this view.
    if (
      active &&
      active !== document.body &&
      !active.closest(
        '[role="tree"], [role="tab"], .editor-open-documents-trigger, .cm-content',
      )
    )
      return;
    view?.focus();
  }
  onSettled(() => {
    if (disposed) return;
    selectionRevision = props.document.restoredSelection?.revision ?? 0;
    const cached =
      props.cached?.reloadVersion === props.document.reloadVersion
        ? props.cached
        : undefined;
    buffer = cached ?? {
      reloadVersion: props.document.reloadVersion,
      state: EditorState.create({ doc: props.document.content }),
      language: new Compartment(),
      presentation: new Compartment(),
      lsp: new Compartment(),
      theme: new Compartment(),
      bindings: new Compartment(),
      editable: new Compartment(),
      wrap: new Compartment(),
      vim: new Compartment(),
      scrollTop: 0,
      scrollLeft: 0,
    };
    const wrap = props.wrap ? EditorView.lineWrapping : [];
    const state = cached
      ? buffer.state.update({
          effects: [
            buffer.presentation.reconfigure(props.live ? livePreview() : []),
            buffer.lsp.reconfigure([]),
            buffer.bindings.reconfigure(bindings()),
            buffer.theme.reconfigure(darkTheme()),
            buffer.editable.reconfigure(editable()),
            buffer.wrap.reconfigure(wrap),
            buffer.vim.reconfigure(vimBindings()),
          ],
        }).state
      : EditorState.create({
          doc: props.document.content,
          extensions: [
            buffer.vim.of(vimBindings()),
            sourceExtensions,
            buffer.language.of([]),
            buffer.presentation.of(props.live ? livePreview() : []),
            buffer.lsp.of([]),
            buffer.theme.of(darkTheme()),
            buffer.bindings.of(bindings()),
            buffer.editable.of(editable()),
            buffer.wrap.of(wrap),
          ],
        });
    props.onView?.(viewId, documentId, false);
    view = new EditorView({ parent: host, state });
    lastActivation = props.activation;
    configuredLive = props.live;
    configuredWrap = props.wrap;
    projectionContent = state.doc.toString();
    applyCollaborators();
    reportView();
    window.addEventListener("focus", reportView);
    window.addEventListener("blur", reportView);
    document.addEventListener("visibilitychange", reportView);
    view.scrollDOM.scrollTop = buffer.scrollTop;
    view.scrollDOM.scrollLeft = buffer.scrollLeft;
    detachPreviewSync = previewSync?.mountEditor(documentId, view);
    cursor(view.state);
    void configureLanguage(props.document.path);
    configureLsp(props.document.path);
    observer = new MutationObserver(() => {
      if (view)
        view.dispatch({ effects: buffer.theme.reconfigure(darkTheme()) });
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    focusIfIdle();
  });
  createEffect(
    () => props.activation,
    (activation) => {
      // Reopening the current document does not mount another view. Honor that
      // explicit activation through EditorView so its cached selection is also
      // written back to the DOM. Presence and save updates do not change it.
      // Solid effects also apply when a snapshot changes but this number does
      // not. Focusing then would overwrite an IME's unflushed DOM selection.
      if (lastActivation === activation) return;
      lastActivation = activation;
      const target = view;
      if (!target) return;
      onSettled(() => {
        if (
          !disposed &&
          view === target &&
          props.document.id === documentId &&
          props.activation === activation
        )
          focusIfIdle();
      });
    },
  );
  createEffect(
    () => props.document.path,
    (path) => {
      if (view) void configureLanguage(path);
    },
  );
  createEffect(
    () =>
      [props.document.path, props.document.deleted, props.lspClient] as const,
    ([path]) => {
      configureLsp(path);
    },
  );
  createEffect(
    () =>
      props.document.locked ||
      !!props.document.inputFailure ||
      !!props.document.readOnlyReason,
    () => {
      if (
        view &&
        (view.state.facet(EditorState.readOnly) !== readOnly() ||
          view.state.facet(EditorView.editable) !== acceptsInput())
      )
        view.dispatch({ effects: buffer.editable.reconfigure(editable()) });
    },
  );
  createEffect(
    () => props.live,
    (enabled) => {
      if (view && configuredLive !== enabled) {
        configuredLive = enabled;
        view.dispatch({
          effects: buffer.presentation.reconfigure(
            enabled ? livePreview() : [],
          ),
        });
      }
    },
  );
  createEffect(
    () => props.vim,
    (enabled) => {
      if (view)
        view.dispatch({ effects: buffer.vim.reconfigure(vimBindings()) });
      if (!enabled) props.onVimMode(null);
    },
  );
  createEffect(
    () => props.wrap,
    (wrap) => {
      if (view && configuredWrap !== wrap) {
        configuredWrap = wrap;
        view.dispatch({
          effects: buffer.wrap.reconfigure(wrap ? EditorView.lineWrapping : []),
        });
      }
    },
  );
  createEffect(
    () => ({
      content: props.document.content,
      selection: props.document.restoredSelection,
      remote: props.document.remoteChange,
    }),
    ({ content, selection, remote }) => {
      if (!view) return;
      const before = view.state.doc.toString();
      if (
        before === content &&
        (!selection || selection.revision === selectionRevision)
      )
        return;
      const changes =
        before === content
          ? undefined
          : remote?.before === before
            ? remote.edits
            : minimalChange(before, content);
      const restore = selection && selection.revision !== selectionRevision;
      if (restore) selectionRevision = selection.revision;
      view.dispatch({
        changes,
        ...(restore
          ? {
              selection: EditorSelection.create(
                selection.ranges.map((range) =>
                  // Core undo restores the operator's original selection.
                  // Vim normal mode needs its start cursor, or a restored dd
                  // range enters visual mode and the next u lowercases it.
                  vimNormalMode(view!)
                    ? EditorSelection.cursor(Math.min(range.anchor, range.head))
                    : EditorSelection.range(range.anchor, range.head),
                ),
                selection.mainIndex,
              ),
            }
          : {}),
        annotations: [
          serviceUpdate.of(true),
          Transaction.addToHistory.of(false),
        ],
      });
    },
  );
  createEffect(
    () => props.reveal,
    (request) => {
      if (
        !view ||
        !request ||
        request.from < 0 ||
        request.to < request.from ||
        request.to > view.state.doc.length
      )
        return;
      view.dispatch({
        selection: EditorSelection.single(request.from, request.to),
        // The mapped range may span many lines. Reveal its start instead of
        // moving to the selection head at the end of an already visible node.
        effects: EditorView.scrollIntoView(request.from, {
          y: "nearest",
          x: "nearest",
          yMargin: 0,
        }),
      });
      onSettled(() => view?.focus());
    },
  );
  createEffect(
    () => ({
      collaborators: props.document.collaborators,
      content: props.document.content,
    }),
    applyCollaborators,
  );
  onCleanup(() => {
    props.onView?.(viewId, null, false);
    detachPreviewSync?.();
    disposed = true;
    window.removeEventListener("focus", reportView);
    window.removeEventListener("blur", reportView);
    document.removeEventListener("visibilitychange", reportView);
    observer?.disconnect();
    if (view) {
      let state = view.state;
      if (state.field(compositionState)) {
        state = state.update({ effects: setComposing.of(false) }).state;
        props.onComposition?.(false);
      }
      props.onCache({
        ...buffer,
        state,
        scrollTop: view.scrollDOM.scrollTop,
        scrollLeft: view.scrollDOM.scrollLeft,
      });
      view.destroy();
    }
  });
  return (
    <div class="code-editor">
      <Show when={languageError()}>
        <p role="alert" class="px-4 py-2 text-ui-sm text-danger">
          语法高亮加载失败，仍可继续编辑和保存。
        </p>
      </Show>
      <div ref={host} class="code-editor-host" />
    </div>
  );
}
