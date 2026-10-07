import { ChangeSet } from "@codemirror/state";
import type {
  Affinity,
  SelectionContext,
  TextEdit,
  ViewEdit,
} from "./contract";

export const MAX_SELECTION_RANGES = 16;
export function memberColor(color: string) {
  return /^#[0-9a-f]{6}$/i.test(color) ? color : "#2563eb";
}
export function boundedSelection(
  selection: SelectionContext,
): SelectionContext {
  const ranges = selection.ranges.slice(0, MAX_SELECTION_RANGES);
  if (selection.mainIndex >= MAX_SELECTION_RANGES)
    ranges[MAX_SELECTION_RANGES - 1] = selection.ranges[selection.mainIndex];
  return {
    ranges,
    mainIndex: Math.min(selection.mainIndex, ranges.length - 1),
  };
}
export function anchorPositions(
  selection: SelectionContext,
): [number, Affinity][] {
  return selection.ranges.flatMap(({ anchor, head }) => {
    const backwards = anchor > head;
    return [
      [anchor, backwards ? "before" : "after"],
      [head, head >= anchor ? (head === anchor ? "after" : "before") : "after"],
    ] as [number, Affinity][];
  });
}
export function mapSelection(
  selection: SelectionContext,
  changes: ChangeSet,
): SelectionContext {
  return {
    ...selection,
    ranges: selection.ranges.map(({ anchor, head }) => ({
      anchor: changes.mapPos(anchor, anchor <= head ? 1 : -1),
      head: changes.mapPos(head, head <= anchor ? 1 : -1),
    })),
  };
}
export function projectSelection(
  selection: SelectionContext,
  acceptedLength: number,
  inputs: readonly Pick<ViewEdit, "edits">[],
): SelectionContext {
  let result = selection;
  let length = acceptedLength;
  for (const input of inputs) {
    const changes = ChangeSet.of(input.edits, length);
    result = mapSelection(result, changes);
    length = changes.newLength;
  }
  return result;
}
export function mapViewSelection(
  selection: SelectionContext,
  length: number,
  edits: TextEdit[],
) {
  return mapSelection(selection, ChangeSet.of(edits, length));
}
