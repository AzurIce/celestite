import { ChangeSet } from "@codemirror/state";
import type { SelectionContext, TextEdit, Version, ViewEdit } from "./contract";
export function sameVersion(a: Version, b: Version) {
  return (
    a.identity.document_id === b.identity.document_id &&
    a.identity.history_id === b.identity.history_id &&
    Object.keys(a.clocks).length === Object.keys(b.clocks).length &&
    Object.entries(a.clocks).every(([peer, clock]) => b.clocks[peer] === clock)
  );
}
export function editsOf(changes: ChangeSet): TextEdit[] {
  const edits: TextEdit[] = [];
  changes.iterChanges((from, to, _fromB, _toB, insert) =>
    edits.push({ from, to, insert: insert.toString() }),
  );
  return edits;
}
function selectionThrough(
  selection: SelectionContext,
  changes: ChangeSet,
): SelectionContext {
  return {
    ...selection,
    ranges: selection.ranges.map((r) => ({
      anchor: changes.mapPos(r.anchor),
      head: changes.mapPos(r.head),
    })),
  };
}
/** Rebase optimistic view inputs through an accepted remote change, retaining
 * their object identity because an input may already have a queued RPC. */
export function rebaseInputs(
  before: string,
  remoteEdits: TextEdit[],
  inputs: ViewEdit[],
) {
  let remote = ChangeSet.of(remoteEdits, before.length);
  let oldLength = before.length;
  let projected = remote.apply(importText(before)).toString();
  for (const input of inputs) {
    const local = ChangeSet.of(input.edits, oldLength);
    const mapped = local.map(remote, true);
    const nextRemote = remote.map(local);
    input.before = selectionThrough(input.before, remote);
    input.after = selectionThrough(input.after, nextRemote);
    input.edits = editsOf(mapped);
    projected = mapped.apply(importText(projected)).toString();
    input.content = projected;
    oldLength = local.newLength;
    remote = nextRemote;
  }
  return { content: projected, edits: editsOf(remote) };
}
import { Text } from "@codemirror/state";
function importText(text: string) {
  return Text.of(text.split("\n"));
}
