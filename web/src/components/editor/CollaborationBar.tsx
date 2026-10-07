import { For } from "solid-js";
import type { CollaborationSnapshot } from "@/lib/editor/contract";
import { memberColor } from "@/lib/editor/presence";

export function CollaborationBar(props: {
  state: CollaborationSnapshot;
  documentId: string | null;
}) {
  const viewing = () =>
    props.state.members.filter((member) =>
      member.views.some((view) => view.documentId === props.documentId),
    );
  const description = (member: CollaborationSnapshot["members"][number]) => {
    const views = member.views.filter(
      (view) => view.documentId === props.documentId,
    );
    return views.some((view) => view.focused)
      ? "正在查看本文档 · 已聚焦"
      : views.length
        ? "正在查看本文档"
        : member.views.length
          ? "正在查看其他文档"
          : "未打开视图";
  };
  return (
    <details class="collaboration-bar" aria-label="协作成员">
      <summary>
        <span class="collaboration-avatars" aria-hidden="true">
          <For each={props.state.members.slice(0, 5)}>
            {(member) => (
              <span
                class="collaboration-avatar"
                style={{ "--collaborator-color": memberColor(member.color) }}
                title={member.name}
              >
                {member.sessionId === props.state.sessionId
                  ? "我"
                  : member.name.slice(-2)}
              </span>
            )}
          </For>
        </span>
        <span role="status" aria-label="在线成员">
          {props.state.members.length} 人在线 · {viewing().length} 人查看本文档
        </span>
      </summary>
      <ul aria-label="在线成员列表">
        <For each={props.state.members}>
          {(member) => (
            <li data-member-id={member.sessionId}>
              <span
                class="collaboration-avatar"
                style={{ "--collaborator-color": memberColor(member.color) }}
                aria-hidden="true"
              >
                {member.name.slice(-2)}
              </span>
              <span class="collaboration-member-info">
                <span>
                  {member.name}
                  {member.sessionId === props.state.sessionId ? "（我）" : ""}
                </span>
                <small>
                  {description(member)}
                  {member.readOnly ? " · 只读" : ""}
                </small>
              </span>
            </li>
          )}
        </For>
      </ul>
    </details>
  );
}
