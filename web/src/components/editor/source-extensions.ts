import { EditorState } from "@codemirror/state";
import {
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
import { syntaxFolds } from "./tree-sitter";

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

/** Shared source-editor presentation; deliberately no CodeMirror history. */
export const sourceExtensions = [
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
];
