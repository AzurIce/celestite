import { test } from "node:test";
import assert from "node:assert/strict";
import { Compartment, EditorState, EditorSelection } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";
import {
  livePreview,
  presentationGrammar,
  setSyntaxPresentation,
  syntaxPresentation,
} from "../../src/components/editor/live-preview";
import {
  compositionState,
  setComposing,
} from "../../src/lib/editor/composition";
import {
  collaboratorField,
  setCollaborators,
} from "../../src/components/editor/collaborators";
import type { PresentationRange } from "../../src/lib/syntax/contract";

const source = "**bold**\n\nplain";
const strong: PresentationRange = {
  from: 0,
  to: 8,
  kind: "strong",
  markers: [
    { from: 0, to: 2 },
    { from: 6, to: 8 },
  ],
};
function fixture(
  text = source,
  ranges: PresentationRange[] = [strong],
  enabled = true,
) {
  const display = new Compartment();
  const grammar = new Compartment();
  let state = EditorState.create({
    doc: text,
    selection: { anchor: text.length },
    extensions: [
      grammar.of(presentationGrammar.of({ grammar: "notist_markdown" })),
      EditorState.allowMultipleSelections.of(true),
      syntaxPresentation,
      compositionState,
      collaboratorField,
      display.of(enabled ? livePreview() : []),
    ],
  });
  state = state.update({
    effects: setSyntaxPresentation.of({ doc: state.doc, ranges }),
  }).state;
  return { state, display, grammar };
}
function replacements(state: EditorState) {
  const result: { from: number; to: number }[] = [];
  const view = { state } as EditorView;
  for (const atomic of state.facet(EditorView.atomicRanges))
    atomic(view).between(0, state.doc.length, (from, to) => {
      result.push({ from, to });
    });
  return result;
}
function marks(state: EditorState) {
  const result: { from: number; to: number; className: string | undefined }[] =
    [];
  for (const decorations of state.facet(EditorView.decorations)) {
    if (typeof decorations === "function") continue;
    decorations.between(0, state.doc.length, (from, to, value) => {
      if (!value.spec.liveMarker)
        result.push({
          from,
          to,
          className: value.spec.class ?? value.spec.attributes?.class,
        });
    });
  }
  return result;
}
function decorationSpecs(state: EditorState) {
  const result: {
    from: number;
    to: number;
    className: string | undefined;
    attributes: Record<string, string> | undefined;
  }[] = [];
  for (const decorations of state.facet(EditorView.decorations)) {
    if (typeof decorations === "function") continue;
    decorations.between(0, state.doc.length, (from, to, value) => {
      result.push({
        from,
        to,
        className: value.spec.class ?? value.spec.attributes?.class,
        attributes: value.spec.attributes,
      });
    });
  }
  return result;
}
function allDecorations(state: EditorState): DecorationSet {
  return (
    (state
      .facet(EditorView.decorations)
      .find(
        (value) => typeof value !== "function" && value.size > 0,
      ) as DecorationSet) ?? Decoration.none
  );
}
function separatorLines(state: EditorState) {
  return marks(state)
    .filter(({ className }) =>
      className?.split(/\s+/).includes("cm-live-separator"),
    )
    .map(({ from }) => from);
}

test("source-to-live uses cached CST metadata and disabling live removes its decorations", () => {
  const { state: initial, display } = fixture(source, [strong], false);
  assert.deepEqual(replacements(initial), []);
  const enabled = initial.update({
    effects: display.reconfigure(livePreview()),
  }).state;
  assert.deepEqual(replacements(enabled), strong.markers);
  assert.ok(marks(enabled).some((mark) => mark.className === "cm-live-strong"));
  assert.equal(enabled.doc.toString(), source);
  const disabled = enabled.update({ effects: display.reconfigure([]) }).state;
  assert.deepEqual(replacements(disabled), []);
  assert.equal(marks(disabled).length, 0);
  assert.deepEqual(disabled.field(syntaxPresentation), [strong]);
});

test("local ranges and remote cursors expose their complete semantic construct", () => {
  const { state } = fixture();
  const local = state.update({
    selection: EditorSelection.create([
      EditorSelection.cursor(source.length),
      EditorSelection.range(3, 5),
    ]),
  }).state;
  assert.deepEqual(replacements(local), []);
  const remote = state.update({
    effects: setCollaborators.of([
      {
        sessionId: "remote",
        viewId: "remote-view",
        name: "Remote",
        color: "blue",
        focused: true,
        readOnly: false,
        ranges: [{ anchor: 1, head: 1 }],
        mainIndex: 0,
      },
    ]),
  }).state;
  assert.deepEqual(replacements(remote), []);
  const left = remote.update({ effects: setCollaborators.of([]) }).state;
  assert.deepEqual(replacements(left), strong.markers);
});

test("edited ranges retain style but cannot hide new input until matching CST arrives", () => {
  const { state } = fixture();
  const oldDoc = state.doc;
  const edited = state.update({ changes: { from: 1, insert: "NEW" } }).state;
  assert.deepEqual(replacements(edited), []);
  assert.ok(marks(edited).some((mark) => mark.className === "cm-live-strong"));
  const stale = edited.update({
    effects: setSyntaxPresentation.of({ doc: oldDoc, ranges: [strong] }),
  }).state;
  assert.deepEqual(replacements(stale), []);
  assert.equal(stale.doc.toString(), "*NEW*bold**\n\nplain");
});

test("untouched structures map across source edits without hiding inserted characters", () => {
  const { state } = fixture();
  const changed = state.update({
    changes: { from: source.length, insert: " more" },
  }).state;
  assert.deepEqual(replacements(changed), strong.markers);
  assert.equal(changed.doc.toString(), source + " more");
  const before = state.update({
    changes: { from: 0, insert: "prefix " },
  }).state;
  assert.deepEqual(
    replacements(before),
    [],
    "an insertion at the marker boundary invalidates hiding",
  );
});

test("composition freezes decoration identity and defers fresh CST until the final input", () => {
  let { state } = fixture();
  const before = allDecorations(state);
  state = state.update({ effects: setComposing.of(true) }).state;
  assert.equal(allDecorations(state), before);
  state = state.update({
    selection: { anchor: 4 },
    effects: setSyntaxPresentation.of({ doc: state.doc, ranges: [] }),
  }).state;
  assert.equal(
    allDecorations(state),
    before,
    "selection and parse results cannot restructure composing DOM",
  );
  state = state.update({ changes: { from: 4, insert: "中文" } }).state;
  assert.equal(state.doc.toString(), "**bo中文ld**\n\nplain");
  assert.ok(marks(state).some((mark) => mark.className === "cm-live-strong"));
  state = state.update({ effects: setComposing.of(false) }).state;
  assert.deepEqual(replacements(state), []);
  assert.equal(
    marks(state).length,
    0,
    "composition end uses the latest metadata, not frozen stale ranges",
  );
});

test("enabling live mode during composition waits for its final input", () => {
  const { state: initial, display } = fixture(source, [strong], false);
  const composing = initial.update({ effects: setComposing.of(true) }).state;
  const enabled = composing.update({
    effects: display.reconfigure(livePreview()),
  }).state;
  assert.deepEqual(replacements(enabled), []);
  assert.equal(marks(enabled).length, 0);
  const ended = enabled.update({ effects: setComposing.of(false) }).state;
  assert.deepEqual(replacements(ended), strong.markers);
  assert.ok(marks(ended).some((mark) => mark.className === "cm-live-strong"));
});

test("composition drops touched marker replacements before they can conceal source edits", () => {
  let { state } = fixture();
  state = state.update({ effects: setComposing.of(true) }).state;
  state = state.update({ changes: { from: 1, insert: "中文" } }).state;
  assert.deepEqual(replacements(state), [{ from: 8, to: 10 }]);
  assert.equal(state.doc.sliceString(0, 5), "*中文*b");
});

test("a grammar change clears ranges before its new syntax worker can reply", () => {
  const { state, grammar } = fixture();
  const changed = state.update({
    effects: grammar.reconfigure(presentationGrammar.of({ grammar: "notist" })),
  }).state;
  assert.deepEqual(changed.field(syntaxPresentation), []);
  assert.deepEqual(replacements(changed), []);
});

test("a new parser for the same grammar cannot reuse its predecessor's ranges", () => {
  const { state, grammar } = fixture();
  const changed = state.update({
    effects: grammar.reconfigure(
      presentationGrammar.of({ grammar: "notist_markdown" }),
    ),
  }).state;
  assert.deepEqual(changed.field(syntaxPresentation), []);
  assert.deepEqual(replacements(changed), []);
});

test("parser failure restores hidden source even while composition keeps its style DOM", () => {
  let { state } = fixture();
  state = state.update({ effects: setComposing.of(true) }).state;
  state = state.update({
    effects: setSyntaxPresentation.of({
      doc: state.doc,
      ranges: [],
      failed: true,
    }),
  }).state;
  assert.deepEqual(replacements(state), []);
  assert.ok(marks(state).some((mark) => mark.className === "cm-live-strong"));
  state = state.update({ effects: setComposing.of(false) }).state;
  assert.equal(marks(state).length, 0);
});

test("invalid, overlapping and multiline marker replacements are rejected", () => {
  const text = "**x**\n\nplain";
  const ranges: PresentationRange[] = [
    {
      from: 0,
      to: 5,
      kind: "strong",
      markers: [
        { from: 0, to: 2 },
        { from: 3, to: 5 },
      ],
    },
    {
      from: 0,
      to: 5,
      kind: "emphasis",
      markers: [
        { from: 0, to: 1 },
        { from: 4, to: 5 },
      ],
    },
    { from: 0, to: 7, kind: "quote", markers: [{ from: 4, to: 7 }] },
    { from: 0, to: 100, kind: "code", markers: [{ from: 0, to: 2 }] },
  ];
  const { state } = fixture(text, ranges);
  assert.deepEqual(replacements(state), [
    { from: 0, to: 2 },
    { from: 3, to: 5 },
  ]);
  assert.equal(state.doc.toString(), text);
});

const separatedText = "first\n\n\nsecond";
const separator: PresentationRange = {
  from: 6,
  to: 8,
  kind: "separator",
  markers: [],
};

test("confirmed separator lines compress without hiding source and expand around local or remote selections", () => {
  const { state } = fixture(separatedText, [separator]);
  assert.deepEqual(separatorLines(state), [6, 7]);
  assert.deepEqual(
    replacements(state),
    [],
    "blank lines remain real editable source",
  );
  assert.equal(state.doc.toString(), separatedText);
  const entered = state.update({ selection: { anchor: 6 } }).state;
  assert.deepEqual(separatorLines(entered), []);
  const left = entered.update({
    selection: { anchor: separatedText.length },
  }).state;
  assert.deepEqual(separatorLines(left), [6, 7]);
  const remote = left.update({
    effects: setCollaborators.of([
      {
        sessionId: "remote",
        viewId: "view",
        name: "Remote",
        color: "#2563eb",
        focused: true,
        readOnly: false,
        ranges: [{ anchor: 7, head: 7 }],
        mainIndex: 0,
      },
    ]),
  }).state;
  assert.deepEqual(separatorLines(remote), []);
  assert.equal(remote.doc.toString(), separatedText);
});

test("typing content into a separator removes its spacing until current CST confirms blank lines again", () => {
  const { state } = fixture(separatedText, [separator]);
  const oldDoc = state.doc;
  const typed = state.update({ changes: { from: 6, insert: "字" } }).state;
  assert.equal(typed.doc.toString(), "first\n字\n\nsecond");
  assert.deepEqual(separatorLines(typed), []);
  const stale = typed.update({
    effects: setSyntaxPresentation.of({ doc: oldDoc, ranges: [separator] }),
  }).state;
  assert.deepEqual(separatorLines(stale), []);
  const removed = stale.update({
    changes: { from: 6, to: 7, insert: "" },
  }).state;
  const refreshed = removed.update({
    effects: setSyntaxPresentation.of({
      doc: removed.doc,
      ranges: [separator],
    }),
  }).state;
  assert.deepEqual(separatorLines(refreshed), [6, 7]);
  assert.equal(refreshed.doc.toString(), separatedText);
});

const tableText = "| A | B |\n| --- | :---: |\n| one | two |\n\ntail";
const tableRange: PresentationRange = {
  from: 0,
  to: 39,
  kind: "table",
  markers: [
    { from: 0, to: 2 },
    { from: 3, to: 6 },
    { from: 7, to: 9 },
    { from: 10, to: 25 },
    { from: 26, to: 28 },
    { from: 31, to: 34 },
    { from: 37, to: 39 },
  ],
  table: {
    columns: 2,
    rows: [
      {
        from: 0,
        to: 9,
        role: "header",
        cells: [
          { from: 2, to: 3 },
          { from: 6, to: 7, align: "center" },
        ],
      },
      {
        from: 10,
        to: 25,
        role: "delimiter",
        cells: [
          { from: 12, to: 15 },
          { from: 18, to: 23, align: "center" },
        ],
      },
      {
        from: 26,
        to: 39,
        role: "body",
        cells: [
          { from: 28, to: 31 },
          { from: 34, to: 37, align: "center" },
        ],
      },
    ],
  },
};

test("tables render cells by column, collapse the delimiter row and reveal source on selection", () => {
  const { state } = fixture(tableText, [tableRange]);
  assert.deepEqual(replacements(state), tableRange.markers);
  const specs = decorationSpecs(state);
  const header = specs.find(
    (spec) => spec.className === "cm-live-table-header",
  );
  assert.equal(header?.from, 0);
  assert.equal(header?.attributes?.["data-live-table-start"], "true");
  assert.equal(header?.attributes?.["data-live-table-end"], "false");
  assert.equal(header?.attributes?.style, "--live-table-columns:2");
  const delimiter = specs.find(
    (spec) => spec.className === "cm-live-table-delimiter",
  );
  assert.equal(delimiter?.from, 10);
  const body = specs.find((spec) => spec.className === "cm-live-table-row");
  assert.equal(body?.from, 26);
  assert.equal(body?.attributes?.["data-live-table-end"], "true");
  assert.deepEqual(
    specs
      .filter((spec) => spec.className === "cm-live-table-cell")
      .map((spec) => ({
        from: spec.from,
        to: spec.to,
        align: spec.attributes?.["data-live-align"],
        first: spec.attributes?.["data-live-table-first"],
        last: spec.attributes?.["data-live-table-last"],
      })),
    [
      {
        from: 2,
        to: 3,
        align: "left",
        first: "true",
        last: "false",
      },
      {
        from: 6,
        to: 7,
        align: "center",
        first: "false",
        last: "true",
      },
      {
        from: 28,
        to: 31,
        align: "left",
        first: "true",
        last: "false",
      },
      {
        from: 34,
        to: 37,
        align: "center",
        first: "false",
        last: "true",
      },
    ],
  );
  const selected = state.update({ selection: { anchor: 7 } }).state;
  assert.deepEqual(replacements(selected), []);
  assert.equal(
    decorationSpecs(selected).filter((spec) =>
      spec.className?.includes("cm-live-table"),
    ).length,
    0,
  );
  assert.equal(selected.doc.toString(), tableText);
});

test("composition immediately expands a touched separator line so Chinese input cannot be squeezed into a spacer", () => {
  let { state } = fixture(separatedText, [separator]);
  const decorations = allDecorations(state);
  state = state.update({ effects: setComposing.of(true) }).state;
  assert.equal(allDecorations(state), decorations);
  state = state.update({ changes: { from: 6, insert: "中" } }).state;
  assert.equal(state.doc.toString(), "first\n中\n\nsecond");
  assert.ok(!separatorLines(state).includes(state.doc.lineAt(6).from));
  state = state.update({
    effects: setSyntaxPresentation.of({ doc: state.doc, ranges: [] }),
  }).state;
  assert.ok(!separatorLines(state).includes(state.doc.lineAt(6).from));
  state = state.update({ effects: setComposing.of(false) }).state;
  assert.deepEqual(separatorLines(state), []);
  assert.equal(state.doc.toString(), "first\n中\n\nsecond");
});
