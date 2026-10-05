import { after, before, test } from "node:test";
import { expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { SyntaxEngine } from "../../src/lib/syntax/engine";
import type { GrammarName, GrammarSource } from "../../src/lib/syntax/contract";
import { languageName } from "../../src/components/editor/languages";

let engine: SyntaxEngine;
before(async () => {
  const names: GrammarName[] = [
    "notist",
    "notist_code",
    "notist_markdown",
    "notist_markdown_inline",
  ];
  const sources = Object.fromEntries(
    names.map((name) => {
      const file = (suffix: string) =>
        readFileSync(
          new URL(
            `../../src/lib/syntax/grammars/${name}.${suffix}`,
            import.meta.url,
          ),
        );
      return [
        name,
        {
          wasm: new Uint8Array(file("wasm")),
          highlights: file("highlights.scm").toString(),
          injections: file("injections.scm").toString(),
          folds: file("folds.scm").toString(),
        },
      ];
    }),
  ) as Record<GrammarName, GrammarSource>;
  engine = await SyntaxEngine.create(sources);
});
after(() => engine?.destroy());

function tokens(grammar: GrammarName, text: string, capture: string) {
  return engine
    .highlight(grammar, text)
    .spans.filter((span) => span.capture === capture)
    .map((span) => text.slice(span.from, span.to));
}

test("all Notist frontends have language labels, including uppercase extensions", () => {
  expect(
    ["a.md", "a.markdown", "a.nmd", "a.NOTMD", "a.not", "a.NOTC"].map(
      languageName,
    ),
  ).toEqual([
    "Markdown",
    "Markdown",
    "Notist Markdown",
    "Notist Markdown",
    "Notist",
    "Notist Code",
  ]);
});

test("Markdown injections recurse through block and inline children, shielding code and strings", () => {
  const text =
    '# Heading\n\n😀中文 #badge(label: "one")[**bold** #inner[*italic*]]\n\n#panel[\n## Nested\n\n#badge(label: "two")[*inline*]\n\n```not\n#hidden()\n```\n]\n\n`#bad()`\n\n#code(text: """\n#also-hidden()\n""")\n\n| A | B |\n| --- | --- |\n| #badge(label: "table") | **value** |\n';
  expect(tokens("notist_markdown", text, "function.call")).toEqual([
    "badge",
    "inner",
    "panel",
    "badge",
    "code",
    "badge",
  ]);
  expect(tokens("notist_markdown", text, "text.strong")).toContain("**bold**");
  expect(tokens("notist_markdown", text, "text.emphasis")).toContain(
    "*italic*",
  );
  expect(tokens("notist_markdown", text, "text.title")).toContain("Nested");
  expect(tokens("notist_markdown", text, "none")).toContain("#hidden()\n");
});

test("native Notist calls and code declarations use distinct grammar rules", () => {
  const text =
    '= Title\n\n😀中文 #badge(label: "hello", count: 42, enabled: true)[content]\n';
  expect(tokens("notist", text, "function.call")).toEqual(["badge"]);
  expect(tokens("notist", text, "number")).toEqual(["42"]);
  expect(tokens("notist", text, "title")).toEqual(["Title"]);
  const code =
    "/* comment */\nfn 中文(值: String, block?: Bool = false) -> Content<block>;";
  expect(tokens("notist_code", code, "keyword")).toEqual(["fn"]);
  expect(tokens("notist_code", code, "function")).toEqual(["中文"]);
  expect(tokens("notist_code", code, "type")).toEqual([
    "String",
    "Bool",
    "Content",
    "block",
  ]);
});

test("incremental changes preserve UTF-16 positions through astral replacements, multiline edits and undo", () => {
  for (const text of [
    '😀中文 #badge(label: "x")\n',
    '😁中文 #badge(label: "longer")\n',
    '# Heading\n\n😁中文 #badge(label: "longer")[**bold**]\n',
    '# Heading\n\n😁中文 #badge(label: "x")[**bold**]\n',
    '😀中文 #badge(label: "x")\n',
    "",
    '😀中文 #badge(label: "x")\n',
  ]) {
    const spans = engine.highlight("notist_markdown", text).spans;
    const call = spans.find((span) => span.capture === "function.call");
    if (text) {
      expect(call).toEqual({
        from: text.indexOf("badge"),
        to: text.indexOf("badge") + 5,
        capture: "function.call",
      });
      const string = spans.find((span) => span.capture === "string");
      expect(text.slice(string!.from, string!.to)).toMatch(/^"(?:x|longer)"$/);
    } else expect(spans).toEqual([]);
  }
});

test("Markdown sections and nested Notist blocks retain folding ranges", () => {
  const text = "# First\n\n#panel[\n## Nested\n\nbody\n]\n\n# Second\n\nnext\n";
  const { folds } = engine.highlight("notist_markdown", text);
  expect(
    folds.some(
      (range) => range.from === 0 && range.to < text.indexOf("# Second"),
    ),
  ).toBe(true);
  expect(
    folds.some((range) =>
      text.slice(range.from, range.to).startsWith("#panel["),
    ),
  ).toBe(true);
});
