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
    }
  | { version: number; error: string };
