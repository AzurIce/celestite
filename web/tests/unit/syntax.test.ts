import { after, before, test } from "node:test";
import { expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { SyntaxEngine } from "../../src/lib/syntax/engine";
import type { GrammarName, GrammarSource } from "../../src/lib/syntax/contract";
import { languageName } from "../../src/components/editor/languages";

let engine: SyntaxEngine;
let sources: Record<GrammarName, GrammarSource>;
before(async () => {
  const names: GrammarName[] = [
    "notist",
    "notist_code",
    "notist_markdown",
    "notist_markdown_inline",
  ];
  sources = Object.fromEntries(
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

function presented(grammar: GrammarName, text: string) {
  return engine
    .highlight(grammar, text)
    .presentation.filter((range) => range.kind !== "separator")
    .map((range) => ({
      ...range,
      text: text.slice(range.from, range.to),
      markers: range.markers.map((marker) =>
        text.slice(marker.from, marker.to),
      ),
    }));
}

function separators(grammar: GrammarName, text: string) {
  return engine
    .highlight(grammar, text)
    .presentation.filter((range) => range.kind === "separator");
}

test("native markup presents complete CST constructs with UTF-16 offsets and exact delimiters", () => {
  const text =
    '= Title\n\n😀 *bold* _italic_ ``x`y`` [label](target\\(v1\\).not "title") [[page|别名]]\n';
  const ranges = presented("notist", text);
  expect(
    ranges.map(({ kind, text, markers, level }) => ({
      kind,
      text,
      markers,
      level,
    })),
  ).toEqual([
    {
      kind: "heading",
      text: "= Title",
      markers: ["= "],
      level: 1,
    },
    {
      kind: "strong",
      text: "*bold*",
      markers: ["*", "*"],
      level: undefined,
    },
    {
      kind: "emphasis",
      text: "_italic_",
      markers: ["_", "_"],
      level: undefined,
    },
    {
      kind: "code",
      text: "``x`y``",
      markers: ["``", "``"],
      level: undefined,
    },
    {
      kind: "link",
      text: '[label](target\\(v1\\).not "title")',
      markers: ["[", '](target\\(v1\\).not "title")'],
      level: undefined,
    },
    {
      kind: "link",
      text: "[[page|别名]]",
      markers: ["[[page|", "]]"],
      level: undefined,
    },
  ]);
  expect(ranges[1].from).toBe(text.indexOf("*bold*"));
  expect(ranges[1].to).toBe(text.indexOf("*bold*") + "*bold*".length);
});

test("Markdown heading and quote markers come from structural nodes without hiding literal closing hashes", () => {
  const text =
    '## 标题 **粗体** #\n\nSubtitle\n===\n\n> quote *em*\n> second\n\n😀 [label](<a.md> "title") <https://example.com>\n';
  const ranges = presented("notist_markdown", text);
  expect(
    ranges
      .filter((range) => range.kind === "heading")
      .map((range) => ({ level: range.level, markers: range.markers })),
  ).toEqual([
    { level: 2, markers: ["## "] },
    { level: 1, markers: ["==="] },
  ]);
  expect(ranges.find((range) => range.kind === "quote")?.markers).toEqual([
    "> ",
    "> ",
  ]);
  expect(
    ranges
      .filter((range) => range.kind === "link")
      .map(({ text, markers }) => ({ text, markers })),
  ).toEqual([
    { text: '[label](<a.md> "title")', markers: ["[", '](<a.md> "title")'] },
    { text: "<https://example.com>", markers: ["<", ">"] },
  ]);
  const closingHash = text.indexOf(" #") + 1;
  for (const range of engine.highlight("notist_markdown", text).presentation)
    for (const marker of range.markers) {
      expect(marker.from <= closingHash && marker.to > closingHash).toBe(false);
      expect(text.slice(marker.from, marker.to)).not.toMatch(/[\r\n]/);
    }
});

test("pipe tables present rows, trimmed cells and alignments from their CST", () => {
  const markdown =
    "| 左 | 中 | 右 |\n|:--|:-:|--:|\n| **粗体** | `code` | plain |\n";
  const table = presented("notist_markdown", markdown).find(
    (range) => range.kind === "table",
  )!;
  expect(table.markers).toEqual([
    "| ",
    " | ",
    " | ",
    " |",
    "|:--|:-:|--:|",
    "| ",
    " | ",
    " | ",
    " |",
  ]);
  expect(table.table?.columns).toBe(3);
  expect(table.table?.rows.map((row) => row.role)).toEqual([
    "header",
    "delimiter",
    "body",
  ]);
  expect(
    table.table?.rows[0]?.cells.map((cell) =>
      markdown.slice(cell.from, cell.to),
    ),
  ).toEqual(["左", "中", "右"]);
  expect(table.table?.rows[0]?.cells.map((cell) => cell.align)).toEqual([
    "left",
    "center",
    "right",
  ]);
  expect(
    table.table?.rows[2]?.cells.map((cell) =>
      markdown.slice(cell.from, cell.to),
    ),
  ).toEqual(["**粗体**", "`code`", "plain"]);
});

test("indented tables consume their own layout whitespace but not neighbouring markup", () => {
  const text = "  | A | B |  \n  | --- | --- |  \n  | one | two |  ";
  const table = presented("notist_markdown", text).find(
    (range) => range.kind === "table",
  )!;
  expect(table.markers).toEqual([
    "  | ",
    " | ",
    " |  ",
    "  | --- | --- |  ",
    "  | ",
    " | ",
    " |  ",
  ]);
  expect(
    table.table?.rows[0]?.cells.map((cell) => text.slice(cell.from, cell.to)),
  ).toEqual(["A", "B"]);
});

test("native table cells follow the scanner's shielding for calls, comments and escapes", () => {
  const native =
    '| A | B |\n| --- | :---: |\n| #badge(label: "x|y") | a\\|b |\n| /* c|d */ | plain |\n';
  const table = presented("notist", native).find(
    (range) => range.kind === "table",
  )!;
  expect(table.table?.columns).toBe(2);
  expect(table.table?.rows.map((row) => row.role)).toEqual([
    "header",
    "delimiter",
    "body",
    "body",
  ]);
  expect(
    table.table?.rows[2]?.cells.map((cell) => native.slice(cell.from, cell.to)),
  ).toEqual(['#badge(label: "x|y")', "a\\|b"]);
  expect(
    table.table?.rows[3]?.cells.map((cell) => native.slice(cell.from, cell.to)),
  ).toEqual(["/* c|d */", "plain"]);
});

test("presentation follows nested markup bodies while retaining call headers and literal contexts", () => {
  const native =
    '#badge(label: "*hidden*")[*shown*]\n> plain native text\n#quote[body]\n';
  expect(presented("notist", native).map((range) => range.text)).toEqual([
    "*shown*",
  ]);
  const markdown =
    '#panel[\n## Nested\n\n#badge(label: "**secret**")[*inline*]\n]\n\n#badge(label: "**string**")[**body**]\n';
  expect(
    presented("notist_markdown", markdown).map((range) => range.text),
  ).toEqual(["## Nested", "*inline*", "**body**"]);
});

test("code injections and opaque literals retain their source instead of producing nested presentation", () => {
  const text =
    "# Visible\n\n```notist\n= hidden *code*\n```\n\n    # indented **code**\n\n`**literal**`\n\n$**math**$\n\n\\*escaped\\*\n\n![**image alt**](p.png)\n";
  expect(
    presented("notist_markdown", text).map((range) => ({
      kind: range.kind,
      text: range.text,
    })),
  ).toEqual([
    { kind: "heading", text: "# Visible" },
    { kind: "code", text: "`**literal**`" },
  ]);
  const native = "```not\n= hidden *code*\n```\n\n`*literal*` $*math*$\n";
  expect(presented("notist", native).map((range) => range.text)).toEqual([
    "`*literal*`",
  ]);
});

test("incomplete delimiters and recovered call bodies keep editable source visible", () => {
  for (const [grammar, samples] of [
    [
      "notist",
      ["*open", "_open", "`open", "[link](unfinished", "= ", "#badge[*body*"],
    ],
    [
      "notist_markdown",
      ["**open", "`open", "[link](unfinished", "#badge[**body**"],
    ],
  ] as const)
    for (const sample of samples)
      expect(presented(grammar, sample)).toEqual([]);
});

test("unrecognized call spellings retain the remaining content scope, including multiline strings", () => {
  for (const grammar of ["notist", "notist_markdown"] as const) {
    const before =
      grammar === "notist" ? "= Before\n\n*shown*" : "# Before\n\n**shown**";
    for (const call of [
      '#widgets.panel(label: "**hidden** _secret_")[*body*]',
      '#widgets.panel(\nlabel: "**hidden**\n_secret_",\n)[*body*]',
      '#widgets.panel(\n\n"**hidden**\n\n_secret_',
    ]) {
      const text = `${before}\n\n${call}\n\n*remaining source*`;
      expect(presented(grammar, text).map((range) => range.text)).toEqual([
        grammar === "notist" ? "= Before" : "# Before",
        grammar === "notist" ? "*shown*" : "**shown**",
      ]);
    }
  }
});

test("standalone imports retain their source while subsequent headings and body markup still present", () => {
  for (const grammar of ["notist", "notist_markdown"] as const) {
    const heading = grammar === "notist" ? "= Heading" : "# Heading";
    const body = grammar === "notist" ? "*shown*" : "**shown**";
    const text = `#import "./#widgets.panel/_private_.notc" as demo;\n\n${heading}\n\n${body}\n`;
    expect(presented(grammar, text).map((range) => range.text)).toEqual([
      heading,
      body,
    ]);
  }
});

test("call fallback respects nested content scopes without treating escaped hashes or literal targets as calls", () => {
  for (const grammar of ["notist", "notist_markdown"] as const) {
    const nested = `#panel[#widgets.panel(label: "**hidden** _secret_")]\n\n*outside*`;
    expect(presented(grammar, nested).map((range) => range.text)).toEqual([
      "*outside*",
    ]);
    const text =
      '\\#widgets.panel *escaped*\n\n[label](#widgets.panel) *target*\n\n`#widgets.panel`\n\n#badge(label: "#widgets.panel **hidden**")[*body*]\n\n# Heading *after*\n';
    const ranges = presented(grammar, text);
    expect(ranges.map((range) => range.text)).toEqual([
      "*escaped*",
      "[label](#widgets.panel)",
      "*target*",
      "`#widgets.panel`",
      "*body*",
      ...(grammar === "notist_markdown" ? ["# Heading *after*"] : []),
      "*after*",
    ]);
  }
});

test("incremental presentation drops old ranges on edits, incomplete input and undo", () => {
  for (const text of [
    "😀 **one**",
    "😁 **longer**",
    "😁 **open",
    "",
    "😀 **one**",
  ]) {
    const ranges = engine.highlight("notist_markdown", text).presentation;
    if (text.endsWith("**")) {
      expect(ranges).toEqual([
        {
          kind: "strong",
          from: 3,
          to: text.length,
          markers: [
            { from: 3, to: 5 },
            { from: text.length - 2, to: text.length },
          ],
        },
      ]);
    } else expect(ranges).toEqual([]);
  }
});

test("Markdown separators cover only complete blank lines between paragraphs, headings and quotes", () => {
  const text =
    "\n# Heading 😀\n\nfirst\n\n\nsecond\n\n## Next\n\n> quote\n> next\n\nlast\n\n";
  const expected = [
    [text.indexOf("\n\nfirst") + 1, 1],
    [text.indexOf("\n\n\nsecond") + 1, 2],
    [text.indexOf("\n\n##") + 1, 1],
    [text.indexOf("\n\n>") + 1, 1],
    [text.indexOf("\n\nlast") + 1, 1],
  ];
  expect(separators("notist_markdown", text)).toEqual(
    expected.map(([from, length]) => ({
      from,
      to: from + length,
      kind: "separator",
      markers: [],
    })),
  );
});

test("native separators use CST sibling gaps, including nested content and whitespace-only text tokens", () => {
  const text =
    "\n= Heading 😀\n\nfirst\n \t\n\n== Next\n\n#panel[\ninside\n\nsecond\n]\n\nlast\n\n";
  const expected = [
    [text.indexOf("\n\nfirst") + 1, 1],
    [text.indexOf("\n \t\n\n") + 1, 4],
    [text.indexOf("\n\n#panel") + 1, 1],
    [text.indexOf("\n\nsecond") + 1, 1],
    [text.indexOf("\n\nlast") + 1, 1],
  ];
  expect(separators("notist", text)).toEqual(
    expected.map(([from, length]) => ({
      from,
      to: from + length,
      kind: "separator",
      markers: [],
    })),
  );
});

test("separator metadata never enters fenced code, multiline strings or unconfirmed call bodies", () => {
  for (const grammar of ["notist", "notist_markdown"] as const) {
    const text =
      'before\n\n```notist\ninside\n\ncode\n```\n\nafter\n\n#badge(text: """\ninside\n\nstring\n""")[body]\n\nlast\n';
    const ranges = separators(grammar, text);
    expect(ranges.map((range) => range.from)).toEqual([
      text.indexOf("\n\n```") + 1,
      text.indexOf("\n\nafter") + 1,
      text.indexOf("\n\n#badge") + 1,
      text.indexOf("\n\nlast") + 1,
    ]);
    for (const range of ranges)
      expect(text.slice(range.from, range.to)).toBe("\n");
    for (const source of [
      '#widgets.panel(\n\n"inside\n\nstring")[body]\n\nlast',
      '#badge(\n\n"unfinished\n\nstring',
      "#badge[before\n\nafter",
    ])
      expect(separators(grammar, source)).toEqual([]);
  }
  expect(separators("notist_markdown", "    first\n\n    second\n")).toEqual(
    [],
  );
});

test("native body separators require whitespace inside both real CST brackets", () => {
  for (const text of [
    "before\n*bold*\n _emphasis_\nnext",
    "#badge[before\n\nafter]",
    "#badge[ before\n\nafter]",
    "#badge[before\n\nafter ]",
    "#badge[\r\nbefore\r\n\r\nafter]",
    "#badge[before\r\n\r\nafter\r\n]",
    "#widgets.panel[ before\n\nafter ]",
  ])
    expect(separators("notist", text)).toEqual([]);
  for (const [text, blank] of [
    ["#panel[ before\n\nafter ]", "\n"],
    ["#panel[\r\nbefore\r\n\r\nafter\r\n]", "\r\n"],
    ["#badge[outer #panel[ before\n\nafter ] tail]", "\n"],
  ]) {
    const from = text.indexOf("before") + "before".length + blank.length;
    expect(separators("notist", text)).toEqual([
      { from, to: from + blank.length, kind: "separator", markers: [] },
    ]);
  }
  const nested = "#panel[ before\n\n#badge[inner\n\nbody]\n\nafter ]";
  expect(separators("notist", nested).map((range) => range.from)).toEqual([
    nested.indexOf("\n\n#badge") + 1,
    nested.indexOf("\n\nafter") + 1,
  ]);
});

test("incremental separator ranges follow Unicode offsets and lose authority when blank lines become content", () => {
  for (const grammar of ["notist", "notist_markdown"] as const) {
    for (const [text, range] of [
      ["😀 one\n\ntwo", [7, 8]],
      ["😁 one\ntwo", null],
      ["😁 one\n \t\n\ntwo", [7, 11]],
      ["😁 one\n字\ntwo", null],
      ["😀 one\n\ntwo", [7, 8]],
      ["😀 one\r\n \t\r\n\r\nnext\r\n", [8, 14]],
    ] as const)
      expect(separators(grammar, text)).toEqual(
        range
          ? [{ from: range[0], to: range[1], kind: "separator", markers: [] }]
          : [],
      );
  }
});

test("presentation is independent of highlight and folding query captures", async () => {
  const plainQueries = Object.fromEntries(
    Object.entries(sources).map(([name, source]) => [
      name,
      { ...source, highlights: "", folds: "" },
    ]),
  ) as Record<GrammarName, GrammarSource>;
  const cst = await SyntaxEngine.create(plainQueries);
  try {
    const result = cst.highlight(
      "notist_markdown",
      "# Title\n\n**bold** and [label](a.md)\n",
    );
    expect(result.spans).toEqual([]);
    expect(result.folds).toEqual([]);
    expect(result.presentation.map((range) => range.kind)).toEqual([
      "heading",
      "separator",
      "strong",
      "link",
    ]);
  } finally {
    cst.destroy();
  }
});
