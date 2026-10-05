import {
  Edit,
  Language,
  Parser,
  Query,
  type Point,
  type Range,
  type Tree,
} from "web-tree-sitter";
import type { GrammarName, GrammarSource, HighlightSpan } from "./contract";

interface Grammar {
  parser: Parser;
  highlights: Query;
  injections: Query | null;
  folds: Query;
}

function advance(point: Point, text: string): Point {
  let { row, column } = point;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      row++;
      column = 0;
    } else column++;
  }
  return { row, column };
}

/** Both CodeMirror and web-tree-sitter use UTF-16 indices and columns. */
function editTree(tree: Tree, before: string, after: string) {
  let start = 0;
  const end = Math.min(before.length, after.length);
  while (start < end && before[start] === after[start]) start++;
  // Keep a changed astral character together when the high surrogate is shared.
  if (start > 0 && /[\uD800-\uDBFF]/.test(before[start - 1])) start--;
  let oldEnd = before.length;
  let newEnd = after.length;
  while (
    oldEnd > start &&
    newEnd > start &&
    before[oldEnd - 1] === after[newEnd - 1]
  ) {
    oldEnd--;
    newEnd--;
  }
  if (oldEnd < before.length && /[\uDC00-\uDFFF]/.test(before[oldEnd])) {
    oldEnd++;
    newEnd++;
  }
  const startPosition = advance({ row: 0, column: 0 }, before.slice(0, start));
  tree.edit(
    new Edit({
      startIndex: start,
      oldEndIndex: oldEnd,
      newEndIndex: newEnd,
      startPosition,
      oldEndPosition: advance(startPosition, before.slice(start, oldEnd)),
      newEndPosition: advance(startPosition, after.slice(start, newEnd)),
    }),
  );
}

export class SyntaxEngine {
  private grammars = new Map<GrammarName, Grammar>();
  private root: { grammar: GrammarName; tree: Tree; text: string } | undefined;

  static async create(
    sources: Record<GrammarName, GrammarSource>,
    runtime?: string,
  ) {
    await Parser.init(runtime ? { locateFile: () => runtime } : undefined);
    const engine = new SyntaxEngine();
    try {
      for (const name of Object.keys(sources) as GrammarName[]) {
        const source = sources[name];
        const language = await Language.load(source.wasm);
        const parser = new Parser();
        parser.setLanguage(language);
        engine.grammars.set(name, {
          parser,
          highlights: new Query(language, source.highlights),
          folds: new Query(language, source.folds),
          injections: source.injections
            ? new Query(language, source.injections)
            : null,
        });
      }
      return engine;
    } catch (error) {
      engine.destroy();
      throw error;
    }
  }

  highlight(name: GrammarName, text: string) {
    const grammar = this.grammars.get(name)!;
    const previous = this.root;
    if (previous?.grammar === name && previous.text !== text)
      editTree(previous.tree, previous.text, text);
    const tree = grammar.parser.parse(
      text,
      previous?.grammar === name ? previous.tree : undefined,
      { includedRanges: [] },
    );
    if (!tree) throw new Error("Tree-sitter could not parse this document");
    previous?.tree.delete();
    this.root = { grammar: name, tree, text };
    const spans: HighlightSpan[] = [];
    const folds: { from: number; to: number }[] = [];
    const visited = new Set<string>();
    const visit = (
      name: GrammarName,
      tree: Tree,
      ranges: Range[],
      depth: number,
    ) => {
      const grammar = this.grammars.get(name)!;
      for (const { node } of grammar.folds.captures(tree.rootNode)) {
        if (node.endPosition.row > node.startPosition.row) {
          let to = node.endIndex;
          while (to > node.startIndex && /[\r\n]/.test(text[to - 1])) to--;
          folds.push({ from: node.startIndex, to });
        }
      }
      for (const capture of grammar.highlights.captures(tree.rootNode)) {
        const from = capture.node.startIndex;
        const to = capture.node.endIndex;
        // Injection nodes may cross holes; never style their excluded children.
        for (const range of ranges.length
          ? ranges
          : [{ startIndex: 0, endIndex: text.length }]) {
          const start = Math.max(from, range.startIndex);
          const end = Math.min(to, range.endIndex);
          if (start < end)
            spans.push({ from: start, to: end, capture: capture.name });
        }
      }
      if (depth >= 32 || !grammar.injections) return;
      for (const match of grammar.injections.matches(tree.rootNode)) {
        const language =
          match.setProperties?.["injection.language"] ??
          match.captures.find((c) => c.name === "injection.language")?.node
            .text;
        if (!language || !this.grammars.has(language as GrammarName)) continue;
        const includeChildren =
          "injection.include-children" in (match.setProperties ?? {});
        const injected: Range[] = [];
        for (const capture of match.captures.filter(
          (c) => c.name === "injection.content",
        )) {
          const node = capture.node;
          let startIndex = node.startIndex;
          let startPosition = node.startPosition;
          for (const child of includeChildren ? [] : node.children) {
            if (startIndex < child.startIndex)
              injected.push({
                startIndex,
                startPosition,
                endIndex: child.startIndex,
                endPosition: child.startPosition,
              });
            startIndex = child.endIndex;
            startPosition = child.endPosition;
          }
          if (startIndex < node.endIndex)
            injected.push({
              startIndex,
              startPosition,
              endIndex: node.endIndex,
              endPosition: node.endPosition,
            });
        }
        // Intersect with the parent's included ranges before descending.
        const clipped = ranges.length
          ? injected.flatMap((range) =>
              ranges.flatMap((parent) => {
                const startIndex = Math.max(
                  range.startIndex,
                  parent.startIndex,
                );
                const endIndex = Math.min(range.endIndex, parent.endIndex);
                return startIndex < endIndex
                  ? [
                      {
                        startIndex,
                        endIndex,
                        startPosition:
                          startIndex === range.startIndex
                            ? range.startPosition
                            : parent.startPosition,
                        endPosition:
                          endIndex === range.endIndex
                            ? range.endPosition
                            : parent.endPosition,
                      },
                    ]
                  : [];
              }),
            )
          : injected;
        if (!clipped.length) continue;
        const key = `${language}:${clipped.map((r) => `${r.startIndex}-${r.endIndex}`).join(",")}`;
        if (visited.has(key)) continue;
        visited.add(key);
        const child = this.grammars
          .get(language as GrammarName)!
          .parser.parse(text, undefined, { includedRanges: clipped });
        if (!child) continue;
        try {
          visit(language as GrammarName, child, clipped, depth + 1);
        } finally {
          child.delete();
        }
      }
    };
    visit(name, tree, [], 0);
    return { spans, folds };
  }

  destroy() {
    this.root?.tree.delete();
    this.root = undefined;
    for (const grammar of this.grammars.values()) {
      grammar.highlights.delete();
      grammar.injections?.delete();
      grammar.folds.delete();
      grammar.parser.delete();
    }
    this.grammars.clear();
  }
}
