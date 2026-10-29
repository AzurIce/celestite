export type GrammarName =
  "notist" | "notist_code" | "notist_markdown" | "notist_markdown_inline";

export interface GrammarSource {
  wasm: string | Uint8Array;
  highlights: string;
  injections: string;
  folds: string;
}

export interface HighlightSpan {
  from: number;
  to: number;
  capture: string;
}

export type TableAlign = "left" | "center" | "right";

/** One source cell, trimmed to its visible content. */
export interface TableCellRange {
  from: number;
  to: number;
  align?: TableAlign;
}

export interface TableRowRange {
  from: number;
  to: number;
  role: "header" | "delimiter" | "body";
  cells: TableCellRange[];
}

/** Structural table metadata sourced from the CST, never re-parsed from text. */
export interface TableStructure {
  columns: number;
  rows: TableRowRange[];
}

/** Complete CST markup or a confirmed gap between content blocks. */
export interface PresentationRange {
  from: number;
  /** Separators include their blank source lines' terminating newlines. */
  to: number;
  kind:
    | "heading"
    | "strong"
    | "emphasis"
    | "code"
    | "link"
    | "quote"
    | "table"
    | "separator";
  /** Known markup delimiters; separators have no markers. */
  markers: { from: number; to: number }[];
  level?: number;
  table?: TableStructure;
}

export interface HighlightRequest {
  version: number;
  grammar: GrammarName;
  text: string;
}

export type HighlightResponse =
  | {
      version: number;
      spans: HighlightSpan[];
      folds: { from: number; to: number }[];
      presentation: PresentationRange[];
    }
  | { version: number; error: string };
