import type { Node, Range, Tree } from "web-tree-sitter";
import type {
  GrammarName,
  PresentationRange,
  TableAlign,
  TableCellRange,
  TableRowRange,
} from "./contract";

type Marker = PresentationRange["markers"][number];
const span = (node: Node): Marker => ({
  from: node.startIndex,
  to: node.endIndex,
});

/** Opaque code and literal nodes never turn their contents into markup. */
export function isOpaque(node: Node | null): boolean {
  for (; node; node = node.parent)
    if (
      node.isError ||
      node.isMissing ||
      ((node.type === "call" || node.type === "content_block") &&
        node.hasError) ||
      [
        "fenced_code_block",
        "indented_code_block",
        "raw_block",
        "code_span",
        "raw_inline",
        "string",
        "comment",
        "math",
        "link_destination",
        "link_title",
        "image",
        "escape",
        "backslash_escape",
        "html_tag",
        "html_block",
      ].includes(node.type)
    )
      return true;
  return false;
}

function quoteMarkers(node: Node): Marker[] {
  const markers: Marker[] = [];
  const visit = (part: Node) => {
    if (part !== node && part.type === "block_quote") return;
    if (isOpaque(part)) return;
    if (
      part.type === "block_quote_marker" ||
      part.type === "block_continuation"
    ) {
      const text = part.text;
      for (let i = 0; i < text.length; i++)
        if (text[i] === ">") {
          const space = text[i + 1] === " " || text[i + 1] === "\t";
          markers.push({
            from: part.startIndex + i,
            to: part.startIndex + i + (space ? 2 : 1),
          });
        }
      return;
    }
    for (const child of part.namedChildren) visit(child);
  };
  visit(node);
  return markers;
}

const isTableSpace = (char: string | undefined) =>
  char === " " || char === "\t";

/** Hide a pipe together with the whitespace that only existed to pad a cell. */
function tableMarker(
  text: string,
  pipe: number,
  lineFrom: number,
  lineTo: number,
): Marker {
  let from = pipe;
  let to = pipe + 1;
  if (text.slice(lineFrom, pipe).trim() === "") from = lineFrom;
  else while (from > lineFrom && isTableSpace(text[from - 1])) from--;
  while (to < lineTo && isTableSpace(text[to])) to++;
  return { from, to };
}

function contentSpan(text: string, from: number, to: number) {
  while (from < to && /[ \t\r\n]/.test(text[from]!)) from++;
  while (to > from && /[ \t\r\n]/.test(text[to - 1]!)) to--;
  return { from, to };
}

/** A row owns its line's layout whitespace even when the CST token does not. */
function lineSpan(text: string, from: number, to: number) {
  const start = text.lastIndexOf("\n", from - 1) + 1;
  let end = text.indexOf("\n", to);
  if (end < 0) end = text.length;
  if (end > start && text[end - 1] === "\r") end--;
  return { from: start, to: end };
}

function skipQuoted(text: string, index: number): number {
  index++;
  while (index < text.length) {
    if (text[index] === "\\") {
      index += 2;
      continue;
    }
    if (text[index] === '"') return index + 1;
    index++;
  }
  return index;
}

function skipRawString(text: string, index: number): number | undefined {
  let cursor = index + 1;
  let hashes = 0;
  while (text[cursor] === "#") {
    hashes++;
    cursor++;
  }
  if (!hashes || text[cursor] !== '"') return undefined;
  const close = `"${"#".repeat(hashes)}`;
  const end = text.indexOf(close, cursor + 1);
  return end < 0 ? text.length : end + close.length;
}

function skipComment(text: string, index: number): number {
  if (text[index + 1] === "/") return text.length;
  if (text[index + 1] !== "*") return index + 1;
  let depth = 1;
  let cursor = index + 2;
  while (cursor < text.length && depth) {
    if (text[cursor] === "/" && text[cursor + 1] === "*") {
      depth++;
      cursor += 2;
    } else if (text[cursor] === "*" && text[cursor + 1] === "/") {
      depth--;
      cursor += 2;
    } else cursor++;
  }
  return cursor;
}

/** Mirrors the native scanner's shielding for strings, comments and call slots. */
function skipBalanced(
  text: string,
  index: number,
  open: string,
  close: string,
): number {
  let depth = 0;
  let cursor = index;
  while (cursor < text.length) {
    const char = text[cursor]!;
    if (char === '"') {
      cursor = skipQuoted(text, cursor);
      continue;
    }
    if (char === "r") {
      const raw = skipRawString(text, cursor);
      if (raw !== undefined) {
        cursor = raw;
        continue;
      }
      cursor++;
      continue;
    }
    if (char === "/") {
      cursor = skipComment(text, cursor);
      continue;
    }
    if (char === "\\") {
      cursor += 2;
      continue;
    }
    cursor++;
    if (char === open) depth++;
    else if (char === close && --depth === 0) return cursor;
  }
  return cursor;
}

const tableIdentifier = /[\p{L}_][\p{L}\p{N}_]*/uy;

function skipCallPath(text: string, index: number): number | undefined {
  tableIdentifier.lastIndex = index;
  if (!tableIdentifier.exec(text)) return undefined;
  let cursor = tableIdentifier.lastIndex;
  while (text[cursor] === ":" && text[cursor + 1] === ":") {
    tableIdentifier.lastIndex = cursor + 2;
    if (!tableIdentifier.exec(text)) return undefined;
    cursor = tableIdentifier.lastIndex;
  }
  return cursor;
}

/** Rows are opaque native tokens, so split them exactly where the scanner does. */
function scanNativeRow(
  text: string,
): { pipes: number[]; cells: { from: number; to: number }[] } | null {
  const pipes: number[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const char = text[cursor]!;
    if (char === "\\") {
      cursor += 2;
      continue;
    }
    if (char === "/") {
      cursor = skipComment(text, cursor);
      continue;
    }
    if (char === "#") {
      cursor++;
      const pathEnd = skipCallPath(text, cursor);
      if (pathEnd !== undefined) {
        cursor = pathEnd;
        if (text[cursor] === "(") cursor = skipBalanced(text, cursor, "(", ")");
        if (text[cursor] === "[") cursor = skipBalanced(text, cursor, "[", "]");
      } else if (text[cursor] === "[")
        cursor = skipBalanced(text, cursor, "[", "]");
      continue;
    }
    if (char === "|") {
      pipes.push(cursor);
      cursor++;
      continue;
    }
    cursor++;
  }
  if (!pipes.length) return null;
  const leading = text.slice(0, pipes[0]!).trim() === "" ? pipes[0] : undefined;
  const last = pipes[pipes.length - 1]!;
  const trailing =
    last !== leading && text.slice(last + 1).trim() === "" ? last : undefined;
  const cells: { from: number; to: number }[] = [];
  let start = leading === undefined ? 0 : leading + 1;
  for (const pipe of pipes)
    if (pipe !== leading && pipe !== trailing) {
      cells.push(contentSpan(text, start, pipe));
      start = pipe + 1;
    }
  cells.push(
    contentSpan(text, start, trailing === undefined ? text.length : trailing),
  );
  return { pipes, cells };
}

function alignFromDelimiter(value: string): TableAlign | undefined {
  const left = value.startsWith(":");
  const right = value.trimEnd().endsWith(":");
  return left && right ? "center" : left ? "left" : right ? "right" : undefined;
}

/** Extract presentation from the real grammar node, never highlight captures. */
export function presentationRanges(
  name: GrammarName,
  tree: Tree,
  text: string,
  ranges: Range[],
  sourceOnly: Marker[],
  sourceEnd: number,
): PresentationRange[] {
  const result: PresentationRange[] = [];
  // An older grammar may leave a newer call spelling as plain markup. There
  // is then no CST string/call boundary to trust, including across blank lines.
  // Keep the rest of that content scope editable instead of parsing it again.
  const unknownCalls = (node: Node) => {
    if (node.type === "call" && node.hasError) {
      let to = sourceEnd;
      for (let parent = node.parent; parent; parent = parent.parent)
        if (parent.type === "content_block") {
          to = Math.min(to, parent.endIndex);
          break;
        }
      // Recovery may split an unfinished body across Markdown paragraphs.
      // Their gaps cannot become separators until the enclosing call closes.
      sourceOnly.push({ from: node.startIndex, to });
      return;
    }
    if (
      isOpaque(node) ||
      sourceOnly.some(
        (source) =>
          source.from <= node.startIndex && source.to >= node.endIndex,
      )
    )
      return;
    if (
      ((name === "notist" && node.type === "text" && node.text === "#") ||
        (name === "notist_markdown_inline" && node.type === "#")) &&
      node.parent?.type !== "call"
    ) {
      const lineEnd = text.indexOf("\n", node.endIndex);
      const end = lineEnd < 0 ? text.length : lineEnd;
      const rest = text.slice(node.endIndex, end);
      // Imports are standalone lines, rather than calls with possibly
      // multiline arguments. Retaining that line must not disable its body.
      if (/^import(?:[ \t\r]|$)/.test(rest)) {
        sourceOnly.push({
          from: text.lastIndexOf("\n", node.startIndex - 1) + 1,
          to: end,
        });
        return;
      }
      if (!/^[\p{L}_][\p{L}\p{N}_]*[.:<(\[]/u.test(rest)) return;
      let scope = tree.rootNode;
      for (let parent = node.parent; parent; parent = parent.parent)
        if (parent.type === "content_block") {
          scope = parent;
          break;
        }
      let from = scope.startIndex;
      // Native markup has no paragraph node. Only whitespace paragraph
      // boundaries are needed here; all actual markup still comes from CST.
      for (
        let lineEnd = text.lastIndexOf("\n", node.startIndex - 1);
        lineEnd >= from;
      ) {
        const lineStart = text.lastIndexOf("\n", lineEnd - 1) + 1;
        if (/^[ \t\r]*$/.test(text.slice(lineStart, lineEnd))) {
          from = lineEnd + 1;
          break;
        }
        if (lineStart <= from) break;
        lineEnd = lineStart - 1;
      }
      sourceOnly.push({
        from,
        to: Math.min(sourceEnd, name === "notist" ? scope.endIndex : sourceEnd),
      });
      return;
    }
    for (const child of node.children) unknownCalls(child);
  };
  if (name === "notist" || name === "notist_markdown_inline")
    unknownCalls(tree.rootNode);
  const included = (from: number, to: number) =>
    !ranges.length ||
    ranges.some((range) => range.startIndex <= from && range.endIndex >= to);
  const separators = (siblings: Node[]) => {
    // Native whitespace-only text tokens belong to the gap, not a paragraph.
    const content = siblings.filter(
      (node) =>
        node.type !== "text" ||
        node.hasError ||
        !/^[ \t\r\n]*$/.test(node.text),
    );
    for (let index = 1; index < content.length; index++) {
      const left = content[index - 1];
      const right = content[index];
      if (
        left.hasError ||
        right.hasError ||
        left.endIndex >= right.startIndex ||
        !/^[ \t\r\n]*$/.test(text.slice(left.endIndex, right.startIndex))
      )
        continue;
      let from = left.endIndex;
      // A block may include its last newline (Markdown), or end before it
      // (native Notist). Only whole blank physical lines are presentation.
      if (from && text[from - 1] !== "\n") {
        const newline = text.indexOf("\n", from);
        if (newline < 0 || newline >= right.startIndex) continue;
        from = newline + 1;
      }
      let to = from;
      for (;;) {
        const newline = text.indexOf("\n", to);
        if (newline < 0 || newline >= right.startIndex) break;
        to = newline + 1;
      }
      if (from < to && included(from, to))
        result.push({ from, to, kind: "separator", markers: [] });
    }
  };
  if (name === "notist_markdown") {
    const blocks: Node[] = [];
    const collect = (node: Node) => {
      // Section spans include trailing whitespace. Expand only these wrappers
      // so a gap before the next heading remains between actual block nodes.
      if (node.type === "document" || node.type === "section")
        for (const child of node.namedChildren) collect(child);
      else blocks.push(node);
    };
    collect(tree.rootNode);
    separators(blocks);
  }
  const add = (
    node: Node,
    kind: PresentationRange["kind"],
    markers: Marker[],
    metadata: Pick<PresentationRange, "level" | "table"> = {},
    span = { from: node.startIndex, to: node.endIndex },
  ) => {
    const from = span.from;
    let to = span.to;
    if (kind === "heading" || kind === "quote" || kind === "table")
      while (to > from && (text[to - 1] === "\n" || text[to - 1] === "\r"))
        to--;
    if (node.hasError || from >= to || !markers.length || !included(from, to))
      return;
    markers.sort((a, b) => a.from - b.from || a.to - b.to);
    const merged: Marker[] = [];
    for (const marker of markers) {
      if (
        marker.from < from ||
        marker.to > to ||
        marker.from >= marker.to ||
        /[\r\n]/.test(text.slice(marker.from, marker.to))
      )
        return;
      const previous = merged[merged.length - 1];
      if (previous && marker.from <= previous.to)
        previous.to = Math.max(previous.to, marker.to);
      else merged.push({ ...marker });
    }
    if (
      merged.reduce((length, marker) => length + marker.to - marker.from, 0) >=
      to - from
    )
      return;
    result.push({ from, to, kind, markers: merged, ...metadata });
  };
  const visit = (node: Node) => {
    if (
      node.isError ||
      node.isMissing ||
      (node.type === "call" && node.hasError)
    )
      return;
    if (name === "notist" && !isOpaque(node)) {
      // The snapshot calls both body flavors content_block. Only brackets
      // flanked by layout whitespace contain blocks in current Notist;
      // an inline body's blank lines are recovered syntax errors.
      const blockBody =
        node.type === "content_block" &&
        node.firstChild?.type === "[" &&
        node.lastChild?.type === "]" &&
        /[ \t\r\n]/.test(text[node.startIndex + 1] ?? "") &&
        /[ \t\r\n]/.test(text[node.endIndex - 2] ?? "");
      if (node.type === "source_file" || blockBody)
        separators(node.namedChildren);
    }
    if (name === "notist") {
      if (node.type === "heading") {
        const marker = node.namedChildren.find(
          (child) => child.type === "heading_marker",
        );
        const title = node.childForFieldName("title");
        if (marker && title) {
          let level = 0;
          while (marker.text[level] === "=") level++;
          add(node, "heading", [span(marker)], { level });
        }
      } else if (node.type === "strong" || node.type === "emphasis") {
        const delimiter = node.type === "strong" ? "*" : "_";
        const markers = node.children
          .filter((child) => child.type === delimiter)
          .map(span);
        if (markers.length === 2) add(node, node.type, markers);
      } else if (node.type === "raw_inline") {
        let length = 0;
        while (node.text[length] === "`") length++;
        if (length && node.text.endsWith("`".repeat(length)))
          add(node, "code", [
            { from: node.startIndex, to: node.startIndex + length },
            { from: node.endIndex - length, to: node.endIndex },
          ]);
      } else if (node.type === "link") {
        const first = node.firstChild;
        const close = node.children.find((child) => child.type === "]");
        const destination = node.childForFieldName("destination");
        if (first?.type === "[" && close && destination)
          add(node, "link", [
            span(first),
            { from: close.startIndex, to: node.endIndex },
          ]);
      } else if (node.type === "wikilink") {
        const first = node.firstChild;
        const last = node.lastChild;
        const target = node.childForFieldName("target");
        const separator = node.children.find((child) => child.type === "|");
        if (first?.type === "[[" && last?.type === "]]" && target)
          add(node, "link", [
            {
              from: first.startIndex,
              to: separator?.endIndex ?? first.endIndex,
            },
            span(last),
          ]);
      } else if (node.type === "table") {
        const parsed = node.namedChildren.map((child) => ({
          child,
          row: scanNativeRow(child.text),
        }));
        const delimiter = parsed.find(
          ({ child }) => child.type === "table_delimiter",
        );
        const alignments =
          delimiter?.row?.cells.map((cell) =>
            alignFromDelimiter(delimiter.child.text.slice(cell.from, cell.to)),
          ) ?? [];
        const header = parsed.find(
          ({ child }) => child.type === "table_header",
        );
        const columns = Math.max(
          alignments.length,
          header?.row?.cells.length ?? 0,
          1,
        );
        const rows: TableRowRange[] = [];
        const markers: Marker[] = [];
        let valid = true;
        for (const { child, row } of parsed) {
          if (!row) {
            valid = false;
            break;
          }
          const role =
            child.type === "table_header"
              ? "header"
              : child.type === "table_delimiter"
                ? "delimiter"
                : "body";
          const line = lineSpan(text, child.startIndex, child.endIndex);
          line.from = Math.max(line.from, node.startIndex);
          line.to = Math.min(line.to, node.endIndex);
          if (role === "delimiter") markers.push(line);
          else
            for (const pipe of row.pipes)
              markers.push(
                tableMarker(text, child.startIndex + pipe, line.from, line.to),
              );
          rows.push({
            from: child.startIndex,
            to: child.endIndex,
            role,
            cells: row.cells.map((cell, index) => {
              const align = alignments[index];
              return {
                from: child.startIndex + cell.from,
                to: child.startIndex + cell.to,
                ...(align ? { align } : {}),
              };
            }),
          });
        }
        if (valid)
          add(node, "table", markers, {
            table: { columns, rows },
          });
      }
    } else if (name === "notist_markdown") {
      if (node.type === "atx_heading" || node.type === "setext_heading") {
        const content = node.childForFieldName("heading_content");
        const marker = node.namedChildren.find(
          (child) =>
            child.type.startsWith("atx_h") || child.type.startsWith("setext_h"),
        );
        if (content && marker) {
          const atx = node.type === "atx_heading";
          const to =
            atx &&
            /^[ \t]*$/.test(text.slice(marker.endIndex, content.startIndex))
              ? content.startIndex
              : marker.endIndex;
          add(node, "heading", [{ from: marker.startIndex, to }], {
            level: Number(marker.type[atx ? 5 : 8]),
          });
        }
      } else if (node.type === "block_quote")
        add(node, "quote", quoteMarkers(node));
      else if (node.type === "pipe_table") {
        const delimiter = node.namedChildren.find(
          (child) => child.type === "pipe_table_delimiter_row",
        );
        const delimiterCells =
          delimiter?.namedChildren.filter(
            (child) => child.type === "pipe_table_delimiter_cell",
          ) ?? [];
        const alignments: (TableAlign | undefined)[] = delimiterCells.map(
          (cell) => {
            const left = cell.children.some(
              (child) => child.type === "pipe_table_align_left",
            );
            const right = cell.children.some(
              (child) => child.type === "pipe_table_align_right",
            );
            return left && right
              ? "center"
              : left
                ? "left"
                : right
                  ? "right"
                  : undefined;
          },
        );
        const header = node.namedChildren.find(
          (child) => child.type === "pipe_table_header",
        );
        const columns = Math.max(
          alignments.length,
          header?.namedChildren.filter(
            (child) => child.type === "pipe_table_cell",
          ).length ?? 0,
          1,
        );
        const rows: TableRowRange[] = [];
        const markers: Marker[] = [];
        for (const row of node.namedChildren) {
          const role =
            row.type === "pipe_table_header"
              ? "header"
              : row.type === "pipe_table_delimiter_row"
                ? "delimiter"
                : "body";
          const line = lineSpan(text, row.startIndex, row.endIndex);
          line.from = Math.max(line.from, node.startIndex);
          line.to = Math.min(line.to, node.endIndex);
          if (role === "delimiter") markers.push(line);
          else
            for (const pipe of row.children)
              if (pipe.type === "|")
                markers.push(
                  tableMarker(text, pipe.startIndex, line.from, line.to),
                );
          const cells: TableCellRange[] = row.namedChildren
            .filter(
              (child) =>
                child.type === "pipe_table_cell" ||
                child.type === "pipe_table_delimiter_cell",
            )
            .map((cell, index) => {
              const { from, to } = contentSpan(
                text,
                cell.startIndex,
                cell.endIndex,
              );
              const align = alignments[index];
              return { from, to, ...(align ? { align } : {}) };
            });
          rows.push({
            from: row.startIndex,
            to: row.endIndex,
            role,
            cells,
          });
        }
        add(node, "table", markers, {
          table: { columns, rows },
        });
      }
    } else if (name === "notist_markdown_inline") {
      if (
        node.type === "emphasis" ||
        node.type === "strong_emphasis" ||
        node.type === "code_span"
      ) {
        const code = node.type === "code_span";
        const markers = node.children
          .filter(
            (child) =>
              child.type ===
              (code ? "code_span_delimiter" : "emphasis_delimiter"),
          )
          .map(span);
        if (markers.length >= 2)
          add(
            node,
            code ? "code" : node.type === "emphasis" ? "emphasis" : "strong",
            markers,
          );
      } else if (node.type === "inline_link") {
        const label = node.namedChildren.find(
          (child) => child.type === "link_text",
        );
        const destination = node.namedChildren.find(
          (child) => child.type === "link_destination",
        );
        if (
          label &&
          destination &&
          node.firstChild?.type === "[" &&
          node.lastChild?.type === ")"
        )
          add(node, "link", [
            { from: node.startIndex, to: label.startIndex },
            { from: label.endIndex, to: node.endIndex },
          ]);
      } else if (
        node.type === "uri_autolink" &&
        node.text.startsWith("<") &&
        node.text.endsWith(">")
      )
        add(node, "link", [
          { from: node.startIndex, to: node.startIndex + 1 },
          { from: node.endIndex - 1, to: node.endIndex },
        ]);
    }
    if (isOpaque(node)) return;
    for (const child of node.namedChildren) visit(child);
  };
  visit(tree.rootNode);
  return result;
}
