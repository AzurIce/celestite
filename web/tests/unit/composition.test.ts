import { test } from "node:test";
import assert from "node:assert/strict";
import { EditorState, Transaction } from "@codemirror/state";
import {
  compositionState,
  setComposing,
} from "../../src/lib/editor/composition";

test("composition spans selection and source transactions until the explicit end", () => {
  let state = EditorState.create({
    doc: "before",
    extensions: [compositionState],
  });
  assert.equal(state.field(compositionState), false);
  state = state.update({ effects: setComposing.of(true) }).state;
  state = state.update({ changes: { from: 6, insert: "中文" } }).state;
  state = state.update({ selection: { anchor: 8 } }).state;
  assert.equal(state.field(compositionState), true);
  const cached = state.update({ effects: setComposing.of(false) }).state;
  assert.equal(cached.field(compositionState), false);
  assert.equal(cached.doc.toString(), "before中文");
});

test("a late browser commit restores the barrier before it reaches update listeners", () => {
  const state = EditorState.create({ extensions: [compositionState] });
  const committed = state.update({
    changes: { from: 0, insert: "文" },
    annotations: Transaction.userEvent.of("input.type.compose"),
  }).state;
  assert.equal(committed.field(compositionState), true);
  assert.equal(committed.doc.toString(), "文");
  const ended = committed.update({
    effects: setComposing.of(false),
  }).state;
  assert.equal(ended.field(compositionState), false);
});
