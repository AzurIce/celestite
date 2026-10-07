import { StateEffect, StateField } from "@codemirror/state";
import { Decoration, EditorView, WidgetType } from "@codemirror/view";
import type { RemoteSelection } from "../../lib/editor/contract";
import { mapSelection, memberColor } from "../../lib/editor/presence";

export const setCollaborators =
  StateEffect.define<readonly RemoteSelection[]>();
class CollaboratorCursor extends WidgetType {
  constructor(
    private member: RemoteSelection,
    private offset: number,
    private primary: boolean,
  ) {
    super();
  }
  eq(other: CollaboratorCursor) {
    return (
      this.offset === other.offset &&
      this.primary === other.primary &&
      this.member.sessionId === other.member.sessionId &&
      this.member.viewId === other.member.viewId &&
      this.member.name === other.member.name &&
      this.member.color === other.member.color &&
      this.member.focused === other.member.focused
    );
  }
  toDOM() {
    const cursor = document.createElement("span");
    cursor.className = `cm-collaborator-cursor${this.member.focused ? " is-focused" : ""}`;
    cursor.style.setProperty(
      "--collaborator-color",
      memberColor(this.member.color),
    );
    cursor.dataset.memberId = this.member.sessionId;
    cursor.dataset.viewId = this.member.viewId;
    cursor.dataset.offset = String(this.offset);
    cursor.setAttribute("aria-label", `${this.member.name}的光标`);
    cursor.title = this.member.name + (this.member.readOnly ? "（只读）" : "");
    if (this.primary) {
      const label = document.createElement("span");
      label.className = "cm-collaborator-label";
      // Keep names out of the editable DOM text and native text selection.
      label.dataset.name = this.member.name;
      label.setAttribute("aria-hidden", "true");
      cursor.append(label);
    }
    return cursor;
  }
  ignoreEvent() {
    return true;
  }
}
function decorations(members: readonly RemoteSelection[]) {
  const ranges = members.flatMap((member) =>
    member.ranges.flatMap(({ anchor, head }, i) => {
      const from = Math.min(anchor, head),
        to = Math.max(anchor, head);
      const cursor = Decoration.widget({
        widget: new CollaboratorCursor(member, head, i === member.mainIndex),
        side: 1,
      }).range(head);
      return from === to
        ? [cursor]
        : [
            Decoration.mark({
              class: `cm-collaborator-selection${member.focused ? " is-focused" : ""}`,
              attributes: {
                style: `--collaborator-color:${memberColor(member.color)}`,
                "data-member-id": member.sessionId,
                title: `${member.name}的选区`,
              },
            }).range(from, to),
            cursor,
          ];
    }),
  );
  return Decoration.set(ranges, true);
}
export const collaboratorField = StateField.define<readonly RemoteSelection[]>({
  create: () => [],
  update(members, transaction) {
    let result = transaction.docChanged
      ? members.map((member) => ({
          ...member,
          ...mapSelection(member, transaction.changes),
        }))
      : members;
    for (const effect of transaction.effects)
      if (effect.is(setCollaborators)) result = effect.value;
    return result.filter((member) =>
      member.ranges.every(
        (range) =>
          range.anchor >= 0 &&
          range.head >= 0 &&
          range.anchor <= transaction.newDoc.length &&
          range.head <= transaction.newDoc.length,
      ),
    );
  },
  provide: (field) => EditorView.decorations.from(field, decorations),
});
