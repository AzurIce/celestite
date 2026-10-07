import type { SelectionContext, UndoContext } from "./contract";

export function undoContext(selection: SelectionContext): UndoContext {
  return {
    metadata: { mainIndex: selection.mainIndex },
    positions: selection.ranges.flatMap((range) => [range.anchor, range.head]),
  };
}
export function restoredSelection(
  context: UndoContext | null,
): SelectionContext | undefined {
  if (!context?.positions.length) return;
  const ranges: SelectionContext["ranges"] = [];
  for (let index = 0; index + 1 < context.positions.length; index += 2)
    ranges.push({
      anchor: context.positions[index],
      head: context.positions[index + 1],
    });
  if (!ranges.length) return;
  const main =
    (context.metadata as { mainIndex?: number } | null)?.mainIndex ?? 0;
  return { ranges, mainIndex: Math.max(0, Math.min(ranges.length - 1, main)) };
}

/** Interaction policy belongs to the view owner. Use input time, never delayed
 * IO completion time, so slow Worker/history/network work cannot split typing. */
export class EditGroups {
  private readonly scope = crypto.randomUUID();
  private sequence = 0;
  private groups = new Map<
    string,
    { origin: string; id: string; time: number }
  >();

  next(id: string, origin: string, time = performance.now()): string | null {
    const explicit = origin.startsWith("input.vim.");
    if (
      !explicit &&
      !origin.startsWith("input.type") &&
      !origin.startsWith("delete.")
    ) {
      this.break(id);
      return null;
    }
    const previous = this.groups.get(id);
    const group =
      previous?.origin === origin && (explicit || time - previous.time <= 500)
        ? previous
        : { origin, id: `${this.scope}:${++this.sequence}`, time };
    group.time = time;
    this.groups.set(id, group);
    return group.id;
  }

  break(id: string) {
    this.groups.delete(id);
  }
}
