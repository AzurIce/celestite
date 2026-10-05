import notist from "./grammars/notist.wasm?url";
import code from "./grammars/notist_code.wasm?url";
import markdown from "./grammars/notist_markdown.wasm?url";
import inline from "./grammars/notist_markdown_inline.wasm?url";
import notistHighlights from "./grammars/notist.highlights.scm?raw";
import codeHighlights from "./grammars/notist_code.highlights.scm?raw";
import markdownHighlights from "./grammars/notist_markdown.highlights.scm?raw";
import inlineHighlights from "./grammars/notist_markdown_inline.highlights.scm?raw";
import markdownInjections from "./grammars/notist_markdown.injections.scm?raw";
import inlineInjections from "./grammars/notist_markdown_inline.injections.scm?raw";
import notistFolds from "./grammars/notist.folds.scm?raw";
import codeFolds from "./grammars/notist_code.folds.scm?raw";
import markdownFolds from "./grammars/notist_markdown.folds.scm?raw";
import inlineFolds from "./grammars/notist_markdown_inline.folds.scm?raw";
import type { GrammarName, GrammarSource } from "./contract";

export const grammarSources: Record<GrammarName, GrammarSource> = {
  notist: {
    wasm: notist,
    highlights: notistHighlights,
    injections: "",
    folds: notistFolds,
  },
  notist_code: {
    wasm: code,
    highlights: codeHighlights,
    injections: "",
    folds: codeFolds,
  },
  notist_markdown: {
    wasm: markdown,
    highlights: markdownHighlights,
    injections: markdownInjections,
    folds: markdownFolds,
  },
  notist_markdown_inline: {
    wasm: inline,
    highlights: inlineHighlights,
    injections: inlineInjections,
    folds: inlineFolds,
  },
};
