import {
  StateEffect,
  StateField,
  Facet,
  type EditorState,
  type Extension,
  type Range,
  type Text,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  WidgetType,
  type DecorationSet,
} from "@codemirror/view";
import type { GrammarName, PresentationRange } from "../../lib/syntax/contract";
import { collaboratorField } from "./collaborators";
import { compositionState } from "../../lib/editor/composition";

/** Syntax replies are tied to the immutable document they were parsed from. */
export const setSyntaxPresentation = StateEffect.define<{
  doc: Text;
  ranges: readonly PresentationRange[];
  failed?: boolean;
}>();

export const presentationGrammar = Facet.define<
  { grammar: GrammarName },
  { grammar: GrammarName } | undefined
>({
  combine: (values) => values[0],
});

/** Keep syntax metadata when the display mode changes, without keeping DOM. */
export const syntaxPresentation = StateField.define<
  readonly PresentationRange[]
>({
  create: () => [],
  update(ranges, transaction) {
    if (
      transaction.startState.facet(presentationGrammar) !==
      transaction.state.facet(presentationGrammar)
    )
      ranges = [];
    if (transaction.docChanged)
      ranges = ranges.flatMap((range) => {
        const from = transaction.changes.mapPos(range.from, 1);
        const to = transaction.changes.mapPos(range.to, -1);
        if (from >= to) return [];
        // Mapped styling can stay stable while typing. Any edited structure
        // loses its hiding authority until a fresh CST confirms its markers.
        const markers = transaction.changes.touchesRange(range.from, range.to)
          ? []
          : range.markers.map((marker) => ({
              from: transaction.changes.mapPos(marker.from, 1),
              to: transaction.changes.mapPos(marker.to, -1),
            }));
        return [{ ...range, from, to, markers }];
      });
    for (const effect of transaction.effects)
      if (
        effect.is(setSyntaxPresentation) &&
        effect.value.doc === transaction.newDoc
      )
        ranges = effect.value.ranges.filter(
          (range) =>
            Number.isInteger(range.from) &&
            Number.isInteger(range.to) &&
            range.from >= 0 &&
            range.from < range.to &&
            range.to <= transaction.newDoc.length,
        );
    return ranges;
  },
});

class TableCellSpacer extends WidgetType {
  constructor(
    readonly align: string,
    readonly first: boolean,
    readonly last: boolean,
  ) {
    super();
  }
  eq(other: TableCellSpacer) {
    return (
      this.align === other.align &&
      this.first === other.first &&
      this.last === other.last
    );
  }
  toDOM() {
    const cell = document.createElement("span");
    cell.className = "cm-live-table-cell cm-live-table-cell-empty";
    cell.dataset.liveAlign = this.align;
    cell.dataset.liveTableFirst = String(this.first);
    cell.dataset.liveTableLast = String(this.last);
    cell.setAttribute("aria-hidden", "true");
    return cell;
  }
  ignoreEvent() {
    return true;
  }
}

/** Empty cells have no text, so sit after the hidden pipe gap they belong to. */
function spacerPosition(
  from: number,
  markers: readonly { from: number; to: number }[],
) {
  let position = from;
  for (let moved = true; moved;) {
    moved = false;
    for (const marker of markers)
      if (marker.from <= position && marker.to > position) {
        position = marker.to;
        moved = true;
      }
  }
  return position;
}

class HiddenMarker extends WidgetType {
  constructor(readonly kind: PresentationRange["kind"]) {
    super();
  }
  eq(other: HiddenMarker) {
    return this.kind === other.kind;
  }
  toDOM() {
    const marker = document.createElement("span");
    marker.className = "cm-live-marker-hidden";
    marker.dataset.liveKind = this.kind;
    marker.setAttribute("aria-hidden", "true");
    return marker;
  }
  ignoreEvent() {
    return true;
  }
}

interface LiveDecorations {
  decorations: DecorationSet;
  atomic: DecorationSet;
}

function presentation(state: EditorState): LiveDecorations {
  const decorations: Range<Decoration>[] = [];
  const markers: {
    from: number;
    to: number;
    kind: PresentationRange["kind"];
  }[] = [];
  const selections = [
    ...state.selection.ranges.map(({ from, to }) => ({ from, to })),
    ...(state.field(collaboratorField, false) ?? []).flatMap((member) =>
      member.ranges.map(({ anchor, head }) => ({
        from: Math.min(anchor, head),
        to: Math.max(anchor, head),
      })),
    ),
  ];
  const lines = new Set<string>();
  const ranges = state.field(syntaxPresentation, false) ?? [];
  const separators = new Set(
    ranges.filter(
      (range) =>
        range.kind === "separator" &&
        state.doc.lineAt(range.from).from === range.from &&
        state.doc.lineAt(range.to).from === range.to &&
        /^[ \t\r\n]+$/.test(state.doc.sliceString(range.from, range.to)),
    ),
  );
  const separatorEnds = new Set([...separators].map((range) => range.to));
  const headingStarts = new Set(
    ranges
      .filter((range) => range.kind === "heading")
      .map((range) => state.doc.lineAt(range.from).from),
  );
  const quoteLines = new Set<number>();
  for (const range of ranges)
    if (range.kind === "quote")
      for (
        let number = state.doc.lineAt(range.from).number;
        number <= state.doc.lineAt(range.to - 1).number;
        number++
      )
        quoteLines.add(number);
  for (const range of ranges) {
    const attributes = { "data-live-kind": range.kind };
    if (range.kind === "separator") {
      if (
        !separators.has(range) ||
        selections.some((selection) =>
          selection.from === selection.to
            ? selection.from >= range.from && selection.from < range.to
            : selection.from < range.to && selection.to > range.from,
        )
      )
        continue;
      const first = state.doc.lineAt(range.from);
      const last = state.doc.lineAt(range.to - 1);
      const gap = headingStarts.has(range.to)
        ? "var(--reading-section-gap)"
        : quoteLines.has(first.number - 1) || quoteLines.has(last.number + 1)
          ? "var(--reading-quote-gap)"
          : "var(--reading-paragraph-gap)";
      for (let number = first.number; number <= last.number; number++)
        decorations.push(
          Decoration.line({
            attributes: {
              ...attributes,
              class: "cm-live-separator",
              style: `--live-separator-lines:${last.number - first.number + 1};--live-separator-gap:${gap}`,
            },
            liveSpacing: true,
          }).range(state.doc.line(number).from),
        );
      continue;
    }
    const selected = selections.some(
      (selection) => selection.from <= range.to && selection.to >= range.from,
    );
    if (range.kind === "table") {
      // Entering a table reveals ordinary source, including its delimiter row,
      // instead of stretching fixed-width cells around visible pipes.
      if (selected || !range.table) continue;
      const table = range.table;
      let last = 0;
      for (let index = 0; index < table.rows.length; index++)
        if (table.rows[index]!.role !== "delimiter") last = index;
      for (let index = 0; index < table.rows.length; index++) {
        const row = table.rows[index]!;
        const line = state.doc.lineAt(row.from);
        if (row.role === "delimiter") {
          decorations.push(
            Decoration.line({
              attributes: { class: "cm-live-table-delimiter" },
              liveSpacing: true,
            }).range(line.from),
          );
          continue;
        }
        const columns = Math.max(table.columns, row.cells.length, 1);
        decorations.push(
          Decoration.line({
            attributes: {
              class:
                row.role === "header"
                  ? "cm-live-table-header"
                  : "cm-live-table-row",
              "data-live-table-role": row.role,
              "data-live-table-start": String(index === 0),
              "data-live-table-end": String(index === last),
              style: `--live-table-columns:${columns}`,
            },
          }).range(line.from),
        );
        for (let cellIndex = 0; cellIndex < row.cells.length; cellIndex++) {
          const cell = row.cells[cellIndex]!;
          const align = cell.align ?? "left";
          const first = cellIndex === 0;
          const last = cellIndex === row.cells.length - 1;
          if (cell.from >= cell.to) {
            decorations.push(
              Decoration.widget({
                widget: new TableCellSpacer(align, first, last),
                side: 1,
              }).range(spacerPosition(cell.from, range.markers)),
            );
            continue;
          }
          decorations.push(
            Decoration.mark({
              class: "cm-live-table-cell",
              attributes: {
                "data-live-align": align,
                "data-live-table-first": String(first),
                "data-live-table-last": String(last),
              },
            }).range(cell.from, cell.to),
          );
        }
      }
      for (const marker of range.markers)
        if (
          Number.isInteger(marker.from) &&
          Number.isInteger(marker.to) &&
          marker.from >= range.from &&
          marker.from < marker.to &&
          marker.to <= range.to &&
          !/[\r\n]/.test(state.doc.sliceString(marker.from, marker.to))
        )
          markers.push({ ...marker, kind: range.kind });
      continue;
    }
    if (range.kind === "heading" || range.kind === "quote") {
      const first = state.doc.lineAt(range.from);
      const last = state.doc.lineAt(range.to - 1);
      const following =
        last.number < state.doc.lines
          ? state.doc.line(last.number + 1)
          : undefined;
      if (
        range.kind === "heading" &&
        following?.text.trim() &&
        !headingStarts.has(following.from)
      ) {
        decorations.push(
          Decoration.line({
            attributes: {
              class: "cm-live-heading-tail",
              style: `--live-heading-after:${quoteLines.has(following.number) ? "var(--reading-quote-gap)" : "var(--reading-paragraph-gap)"}`,
            },
          }).range(last.from),
        );
      }
      for (let number = first.number; number <= last.number; number++) {
        const line = state.doc.line(number);
        const key = `${line.from}:${range.kind}`;
        if (lines.has(key)) continue;
        lines.add(key);
        // A setext underline is its own editable source line. Keep a small,
        // hit-testable line while hidden, rather than replacing a newline.
        const markerLine =
          range.kind === "heading" &&
          number > first.number &&
          range.markers.some(
            (marker) =>
              marker.from <= line.from + line.text.search(/\S/) &&
              marker.to >= line.to,
          );
        if (markerLine) {
          if (!selected)
            decorations.push(
              Decoration.line({
                attributes: { class: "cm-live-heading-marker" },
                liveSpacing: true,
              }).range(line.from),
            );
          continue;
        }
        decorations.push(
          Decoration.line({
            attributes: {
              ...attributes,
              class: `cm-live-${range.kind}`,
              ...(range.kind === "heading"
                ? {
                    "data-live-level": String(
                      Math.max(1, Math.min(6, range.level ?? 1)),
                    ),
                    "data-live-heading-gap": String(
                      number === first.number &&
                        first.number > 1 &&
                        !quoteLines.has(first.number) &&
                        !separatorEnds.has(first.from),
                    ),
                    style: "--live-heading-gap:var(--reading-section-gap)",
                  }
                : {
                    "data-live-quote-start": String(number === first.number),
                    "data-live-quote-end": String(number === last.number),
                  }),
            },
          }).range(line.from),
        );
      }
    } else {
      decorations.push(
        Decoration.mark({
          class: `cm-live-${range.kind}`,
          attributes,
        }).range(range.from, range.to),
      );
    }
    if (selected) continue;
    for (const marker of range.markers)
      if (
        Number.isInteger(marker.from) &&
        Number.isInteger(marker.to) &&
        marker.from >= range.from &&
        marker.from < marker.to &&
        marker.to <= range.to &&
        !/[\r\n]/.test(state.doc.sliceString(marker.from, marker.to))
      )
        markers.push({ ...marker, kind: range.kind });
  }
  // Nested/injected structures must never create overlapping replacements.
  markers.sort((left, right) => left.from - right.from || right.to - left.to);
  const hidden: Range<Decoration>[] = [];
  let end = -1;
  for (const marker of markers) {
    if (marker.from < end) continue;
    end = marker.to;
    hidden.push(
      Decoration.replace({
        widget: new HiddenMarker(marker.kind),
        inclusive: false,
        liveMarker: true,
      }).range(marker.from, marker.to),
    );
  }
  return {
    decorations: Decoration.set([...decorations, ...hidden], true),
    atomic: Decoration.set(hidden, true),
  };
}

const liveDecorations = StateField.define<LiveDecorations>({
  create: (state) =>
    state.field(compositionState, false)
      ? { decorations: Decoration.none, atomic: Decoration.none }
      : presentation(state),
  update(value, transaction) {
    if (transaction.state.field(compositionState, false)) {
      const invalidated =
        transaction.startState.facet(presentationGrammar) !==
          transaction.state.facet(presentationGrammar) ||
        transaction.effects.some(
          (effect) =>
            effect.is(setSyntaxPresentation) &&
            effect.value.doc === transaction.newDoc &&
            effect.value.failed,
        );
      if (!transaction.docChanged && !invalidated) return value;
      // Keep the composing DOM and styles intact. Touched replacements lose
      // their authority immediately, so inserted source can never disappear.
      const filter = (from: number, to: number, decoration: Decoration) => {
        if (decoration.spec.liveSpacing) {
          const line = transaction.startState.doc.lineAt(from);
          return (
            !invalidated &&
            !transaction.changes.touchesRange(line.from, line.to)
          );
        }
        return (
          !decoration.spec.liveMarker ||
          (!invalidated && !transaction.changes.touchesRange(from, to))
        );
      };
      return {
        decorations: value.decorations
          .update({ filter })
          .map(transaction.changes),
        atomic: value.atomic.update({ filter }).map(transaction.changes),
      };
    }
    return presentation(transaction.state);
  },
  provide: (field) => [
    EditorView.decorations.from(field, (value) => value.decorations),
    EditorView.atomicRanges.of((view) => view.state.field(field).atomic),
  ],
});

/** Single editable source document; only its presentation changes. */
export function livePreview(): Extension {
  return [
    liveDecorations,
    EditorView.editorAttributes.of({
      class: "cm-live-preview",
      "data-live-preview": "true",
    }),
  ];
}
