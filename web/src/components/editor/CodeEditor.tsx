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
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLineGutter,
  highlightSpecialChars,
  drawSelection,
  dropCursor,
  rectangularSelection,
  highlightActiveLine,
} from "@codemirror/view";
import { defaultKeymap, indentWithTab } from "@codemirror/commands";
import {
  bracketMatching,
  foldGutter,
  foldKeymap,
  indentOnInput,
  HighlightStyle,
  syntaxHighlighting,
} from "@codemirror/language";
import {
  autocompletion,
  completionKeymap,
  closeBrackets,
  closeBracketsKeymap,
} from "@codemirror/autocomplete";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { tags } from "@lezer/highlight";
import type {
  EditorDocument,
  ViewEdit,
  SelectionContext,
} from "@/lib/editor/contract";
import { languageSupport } from "./languages";
import { syntaxFolds } from "./tree-sitter";
import { vimExtension, vimNormalMode, vimUserEvent, type VimMode } from "./vim";
import "./editor.css";

import type { EditorBuffer } from "@/lib/editor/buffer";
import type { PreviewSync } from "./preview-sync";
interface CodeEditorProps {
  previewSync?: PreviewSync;
  reveal?: { from: number; to: number; requestId: string };
  document: EditorDocument;
  onTransaction: (transaction: ViewEdit) => boolean;
  onComposition?: (active: boolean) => void;
  onView?: (
    viewId: string,
    documentId: string | null,
    focused: boolean,
  ) => void;
  onUndo: (context: SelectionContext, redo: boolean) => void;
  wrap: boolean;
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
const highlight = HighlightStyle.define([
  {
    tag: [tags.keyword, tags.modifier, tags.operatorKeyword],
    class: "cm-token-keyword",
  },
  {
    tag: [tags.string, tags.regexp, tags.special(tags.string)],
    class: "cm-token-string",
  },
  { tag: [tags.number, tags.bool, tags.null], class: "cm-token-number" },
  { tag: [tags.comment, tags.meta], class: "cm-token-comment" },
  {
    tag: [tags.typeName, tags.className, tags.tagName],
    class: "cm-token-type",
  },
  { tag: [tags.heading, tags.strong], class: "cm-token-heading" },
  { tag: tags.emphasis, class: "cm-token-emphasis" },
  { tag: [tags.link, tags.url], class: "cm-token-link" },
]);

export default function CodeEditor(props: CodeEditorProps) {
  const previewSync = untrack(() => props.previewSync);
  const documentId = untrack(() => props.document.id);
  const viewId = crypto.randomUUID();
  let detachPreviewSync: (() => void) | undefined;
  let host!: HTMLDivElement;
  let view: EditorView | undefined;
  let buffer: EditorBuffer;
  let disposed = false;
  let languageRequest = 0;
  let languagePath: string | undefined;
  let selectionRevision = 0;
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
  const undo = (redo: boolean) => (editor: EditorView) => {
    if (!props.document.readOnlyReason && !props.document.core?.historyError)
      props.onUndo(selectionContext(editor.state), redo);
    return true;
  };
  const bindings = () => [
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
      (props.document.locked ||
        props.document.readOnlyReason ||
        props.document.core?.historyError)
        ? []
        : transaction,
    ),
    EditorView.domEventHandlers({
      compositionstart: () => {
        props.onComposition?.(true);
      },
      compositionend: () => {
        setTimeout(() => props.onComposition?.(false), 0);
      },
    }),
    EditorView.contentAttributes.of({
      "aria-label": "代码编辑器",
      spellcheck: "false",
      autocapitalize: "off",
      autocorrect: "off",
    }),
    EditorView.updateListener.of((update) => {
      if (update.focusChanged)
        props.onView?.(viewId, documentId, update.view.hasFocus);
      if (update.docChanged) previewSync?.invalidateEditor(update.view);
      if (update.geometryChanged || update.viewportChanged)
        previewSync?.editorLayoutChanged(update.view);
      if (
        update.docChanged &&
        !update.transactions.some((transaction) =>
          transaction.annotation(serviceUpdate),
        )
      ) {
        const content = update.state.doc.toString();
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
    }),
  ];
  const editable = () => [
    EditorState.readOnly.of(
      props.document.locked ||
        !!props.document.readOnlyReason ||
        !!props.document.core?.historyError,
    ),
    EditorView.editable.of(
      (!props.document.locked || !!props.document.core) &&
        !props.document.inputFailure &&
        !props.document.readOnlyReason &&
        !props.document.core?.historyError,
    ),
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
              props.document.core?.historyError
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
  /**
   * 打开文件时把焦点交给编辑器（与 Zed 一致）。读取是异步的，视图挂载可能
   * 晚于用户已经开始的下一步操作；只有焦点仍留在文件树、编辑器内或文档
   * 空白处时才抢焦点，避免把用户在对话框/输入框里的操作打断。
   */
  function focusIfIdle() {
    const active = document.activeElement;
    if (
      active &&
      active !== document.body &&
      !active.closest('[role="tree"]') &&
      !active.closest('[aria-label="文件编辑器"]')
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
            lineNumbers(),
            highlightActiveLineGutter(),
            highlightSpecialChars(),
            drawSelection(),
            dropCursor(),
            rectangularSelection(),
            EditorState.allowMultipleSelections.of(true),
            EditorState.tabSize.of(2),
            EditorState.phrases.of({
              Find: "查找",
              Replace: "替换",
              next: "下一个",
              previous: "上一个",
              all: "全部",
              "match case": "区分大小写",
              regexp: "正则表达式",
              "by word": "全词匹配",
              replace: "替换",
              "replace all": "全部替换",
              close: "关闭",
              "Go to line": "跳转到行",
              go: "跳转",
            }),
            indentOnInput(),
            bracketMatching(),
            closeBrackets(),
            autocompletion(),
            highlightActiveLine(),
            highlightSelectionMatches(),
            foldGutter({
              foldingChanged: (update) =>
                update.transactions.some((transaction) =>
                  transaction.effects.some((effect) => effect.is(syntaxFolds)),
                ),
            }),
            syntaxHighlighting(highlight),
            keymap.of([
              ...closeBracketsKeymap,
              ...defaultKeymap,
              ...searchKeymap,
              ...foldKeymap,
              ...completionKeymap,
              indentWithTab,
            ]),
            buffer.language.of([]),
            buffer.theme.of(darkTheme()),
            buffer.bindings.of(bindings()),
            buffer.editable.of(editable()),
            buffer.wrap.of(wrap),
          ],
        });
    props.onView?.(viewId, documentId, false);
    view = new EditorView({ parent: host, state });
    view.scrollDOM.scrollTop = buffer.scrollTop;
    view.scrollDOM.scrollLeft = buffer.scrollLeft;
    detachPreviewSync = previewSync?.mountEditor(documentId, view);
    cursor(view.state);
    void configureLanguage(props.document.path);
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
    () => props.document.path,
    (path) => {
      if (view) void configureLanguage(path);
    },
  );
  createEffect(
    () =>
      props.document.locked ||
      !!props.document.inputFailure ||
      !!props.document.readOnlyReason ||
      !!props.document.core?.historyError,
    () => {
      if (view)
        view.dispatch({ effects: buffer.editable.reconfigure(editable()) });
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
      if (view)
        view.dispatch({
          effects: buffer.wrap.reconfigure(wrap ? EditorView.lineWrapping : []),
        });
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
  onCleanup(() => {
    props.onView?.(viewId, null, false);
    detachPreviewSync?.();
    disposed = true;
    observer?.disconnect();
    if (view) {
      props.onCache({
        ...buffer,
        state: view.state,
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
