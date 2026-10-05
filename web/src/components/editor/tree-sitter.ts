import { StateEffect, StateField, type Extension } from "@codemirror/state";
import { foldService } from "@codemirror/language";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import type { GrammarName, HighlightResponse } from "../../lib/syntax/contract";

export const syntaxFolds = StateEffect.define<{ from: number; to: number }[]>();
const foldRanges = StateField.define<Map<number, { from: number; to: number }>>(
  {
    create: () => new Map(),
    update: (ranges, transaction) => {
      if (transaction.docChanged) ranges = new Map();
      for (const effect of transaction.effects)
        if (effect.is(syntaxFolds)) {
          ranges = new Map();
          for (const fold of effect.value) {
            const line = transaction.state.doc.lineAt(fold.from);
            if (fold.to <= line.to) continue;
            const previous = ranges.get(line.from);
            if (!previous || fold.to > previous.to)
              ranges.set(line.from, { from: line.to, to: fold.to });
          }
        }
      return ranges;
    },
  },
);

function tokenClass(capture: string): string | undefined {
  if (capture === "none") return "cm-token-none";
  if (
    ["title", "text.title", "text.strong", "emphasis.strong"].includes(capture)
  )
    return "cm-token-heading";
  if (["emphasis", "text.emphasis"].includes(capture))
    return "cm-token-emphasis";
  if (["strikethrough", "text.strike"].includes(capture))
    return "cm-token-strike";
  if (["link_uri", "link_text", "text.uri", "text.reference"].includes(capture))
    return "cm-token-link";
  if (capture === "comment") return "cm-token-comment";
  if (capture.startsWith("string") || capture === "text.literal")
    return "cm-token-string";
  if (capture === "number" || capture === "constant.builtin")
    return "cm-token-number";
  if (capture.startsWith("keyword") || capture === "variable.builtin")
    return "cm-token-keyword";
  if (capture.startsWith("function")) return "cm-token-function";
  if (capture === "type") return "cm-token-type";
  if (capture === "property" || capture === "variable.parameter")
    return "cm-token-property";
  if (capture.startsWith("punctuation") || capture === "operator")
    return "cm-token-punctuation";
  return undefined;
}

export function treeSitterHighlight(
  grammar: GrammarName,
  onError?: () => void,
): Extension {
  return [
    foldRanges,
    foldService.of((state, start) => {
      return state.field(foldRanges).get(start) ?? null;
    }),
    ViewPlugin.fromClass(
      class {
        decorations: DecorationSet = Decoration.none;
        private worker: Worker;
        private version = 0;
        private timer: ReturnType<typeof setTimeout> | undefined;
        private destroyed = false;
        constructor(private view: EditorView) {
          this.worker = new Worker(
            new URL("../../lib/syntax/worker.ts", import.meta.url),
            { type: "module" },
          );
          this.worker.onmessage = (event: MessageEvent<HighlightResponse>) => {
            const response = event.data;
            if (this.destroyed || response.version !== this.version) return;
            if ("error" in response) {
              onError?.();
              return;
            }
            const marks = response.spans.flatMap((span) => {
              const className = tokenClass(span.capture);
              return className &&
                span.from < span.to &&
                span.to <= this.view.state.doc.length
                ? [
                    Decoration.mark({
                      class: className,
                      attributes: { "data-syntax": span.capture },
                    }).range(span.from, span.to),
                  ]
                : [];
            });
            this.decorations = Decoration.set(marks, true);
            this.view.dispatch({ effects: syntaxFolds.of(response.folds) });
          };
          this.worker.onerror = () => {
            if (!this.destroyed) onError?.();
          };
          this.send();
        }
        update(update: ViewUpdate) {
          if (!update.docChanged) return;
          this.version++;
          this.decorations = this.decorations.map(update.changes);
          // Bound the delay during continuous typing; parse off the UI thread.
          if (!this.timer)
            this.timer = setTimeout(() => {
              this.timer = undefined;
              this.send();
            }, 50);
        }
        private send() {
          this.worker.postMessage({
            version: this.version,
            grammar,
            text: this.view.state.doc.toString(),
          });
        }
        destroy() {
          this.destroyed = true;
          clearTimeout(this.timer);
          this.worker.terminate();
        }
      },
      { decorations: (plugin) => plugin.decorations },
    ),
  ];
}
