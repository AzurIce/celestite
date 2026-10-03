import {
  createEffect,
  createSignal,
  onCleanup,
  onSettled,
  Show,
} from "solid-js";
import { Compartment, EditorState, Prec } from "@codemirror/state";
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
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
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
import type { DocumentSnapshot } from "@/lib/editor/documents";
import { languageSupport } from "./languages";
import "./editor.css";

export interface EditorBuffer {
  state: EditorState;
  language: Compartment;
  theme: Compartment;
  bindings: Compartment;
  editable: Compartment;
  wrap: Compartment;
  scrollTop: number;
  scrollLeft: number;
}
interface CodeEditorProps {
  document: DocumentSnapshot;
  wrap: boolean;
  cached?: EditorBuffer;
  onChange: (content: string) => boolean;
  onSave: () => void;
  onCursor: (line: number, column: number) => void;
  onCache: (buffer: EditorBuffer) => void;
}
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
  let host!: HTMLDivElement;
  let view: EditorView | undefined;
  let buffer: EditorBuffer;
  let disposed = false;
  let languageRequest = 0;
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
  const bindings = () => [
    Prec.highest(
      keymap.of([
        {
          key: "Mod-s",
          run: () => {
            props.onSave();
            return true;
          },
        },
      ]),
    ),
    EditorView.contentAttributes.of({
      "aria-label": "代码编辑器",
      spellcheck: "false",
      autocapitalize: "off",
      autocorrect: "off",
    }),
    EditorView.updateListener.of((update) => {
      if (update.docChanged && !props.onChange(update.state.doc.toString())) {
        // 文件树修改期间的保护；禁止把未接收的输入留在视图中。
        queueMicrotask(() => {
          if (!disposed && view)
            view.dispatch({
              changes: {
                from: 0,
                to: view.state.doc.length,
                insert: props.document.content,
              },
            });
        });
      }
      if (update.docChanged || update.selectionSet) cursor(update.state);
    }),
  ];
  const editable = () => [
    EditorState.readOnly.of(props.document.locked),
    EditorView.editable.of(!props.document.locked),
  ];
  async function configureLanguage(path: string) {
    const request = ++languageRequest;
    setLanguageError(false);
    try {
      const extension = await languageSupport(path);
      if (!disposed && request === languageRequest && view)
        view.dispatch({ effects: buffer.language.reconfigure(extension) });
    } catch {
      if (!disposed && request === languageRequest) setLanguageError(true);
    }
  }
  onSettled(() => {
    if (disposed) return;
    buffer = props.cached ?? {
      state: EditorState.create({ doc: props.document.content }),
      language: new Compartment(),
      theme: new Compartment(),
      bindings: new Compartment(),
      editable: new Compartment(),
      wrap: new Compartment(),
      scrollTop: 0,
      scrollLeft: 0,
    };
    const wrap = props.wrap ? EditorView.lineWrapping : [];
    const state = props.cached
      ? buffer.state.update({
          effects: [
            buffer.bindings.reconfigure(bindings()),
            buffer.theme.reconfigure(darkTheme()),
            buffer.editable.reconfigure(editable()),
            buffer.wrap.reconfigure(wrap),
          ],
        }).state
      : EditorState.create({
          doc: props.document.content,
          extensions: [
            lineNumbers(),
            highlightActiveLineGutter(),
            highlightSpecialChars(),
            history(),
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
            foldGutter(),
            syntaxHighlighting(highlight),
            keymap.of([
              ...closeBracketsKeymap,
              ...defaultKeymap,
              ...historyKeymap,
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
    view = new EditorView({ parent: host, state });
    view.scrollDOM.scrollTop = buffer.scrollTop;
    view.scrollDOM.scrollLeft = buffer.scrollLeft;
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
    view.focus();
  });
  createEffect(
    () => props.document.path,
    (path) => {
      if (view) void configureLanguage(path);
    },
  );
  createEffect(
    () => props.document.locked,
    () => {
      if (view)
        view.dispatch({ effects: buffer.editable.reconfigure(editable()) });
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
  onCleanup(() => {
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
