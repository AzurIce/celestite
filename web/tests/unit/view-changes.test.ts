import { test } from "node:test";
import assert from "node:assert/strict";
import { rebaseInputs } from "../../src/lib/editor/view-changes";
import { applyEdits } from "../../src/lib/editor/client/documents";
import type { ViewEdit } from "../../src/lib/editor/contract";
const selection = (head: number) => ({
  ranges: [{ anchor: head, head }],
  mainIndex: 0,
});
const input = (from: number, insert: string, content: string): ViewEdit => ({
  edits: [{ from, to: from, insert }],
  content,
  before: selection(from),
  after: selection(from + insert.length),
  userEvent: "input",
});
test("remote insert rebases consecutive optimistic inputs and selections", () => {
  const first = input(4, "X", "ab🦀Xcd");
  const second = input(5, "Y", "ab🦀XYcd");
  const result = rebaseInputs(
    "ab🦀cd",
    [{ from: 0, to: 0, insert: "R" }],
    [first, second],
  );
  assert.equal(result.content, "Rab🦀XYcd");
  assert.equal(first.edits[0].from, 5);
  assert.equal(second.edits[0].from, 6);
  assert.equal(second.after.ranges[0].head, 7);
  assert.equal(applyEdits("ab🦀XYcd", result.edits), result.content);
});
test("same-gap concurrent inserts use the same ordering on both projections", () => {
  const first = input(1, "L", "aLb");
  const result = rebaseInputs("ab", [{ from: 1, to: 1, insert: "R" }], [first]);
  assert.equal(applyEdits("aRb", first.edits), result.content);
  assert.equal(applyEdits("aLb", result.edits), result.content);
});
test("overlapping deletes retain queued input and unchanged islands", () => {
  const edit: ViewEdit = {
    edits: [{ from: 2, to: 4, insert: "X" }],
    content: "abXef",
    before: selection(2),
    after: selection(3),
    userEvent: "input",
  };
  const result = rebaseInputs(
    "abcdef",
    [
      { from: 1, to: 3, insert: "" },
      { from: 5, to: 6, insert: "!" },
    ],
    [edit],
  );
  assert.equal(applyEdits("ade!", edit.edits), result.content);
  assert.equal(applyEdits("abXef", result.edits), result.content);
  assert.ok(result.content.includes("X"));
});
