import { For, Show, createSignal, onSettled } from "solid-js";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui";
import { FileText, X } from "@/components/icons";
import type { DocumentsSnapshot } from "@/lib/editor/contract";

interface EditorTabsProps {
  state: DocumentsSnapshot;
  panelId: string;
  onActivate: (id: string) => void;
  canClose: (ids: string[]) => boolean;
  onClose: (ids: string[]) => void;
}

type CloseScope = "current" | "others" | "left" | "right" | "all";
const menuGroups: { scope: CloseScope; label: string }[][] = [
  [
    { scope: "current", label: "关闭标签页" },
    { scope: "others", label: "关闭其他标签页" },
  ],
  [
    { scope: "left", label: "关闭左侧标签页" },
    { scope: "right", label: "关闭右侧标签页" },
  ],
  [{ scope: "all", label: "关闭全部标签页" }],
];

/** Owns tab navigation and context targets, not document close/save policy. */
export function EditorTabs(props: EditorTabsProps) {
  const [contextTab, setContextTab] = createSignal<string | null>(null);
  const tabId = (id: string) => `${props.panelId}-${id}`;
  function targets(scope: CloseScope) {
    const index = props.state.documents.findIndex(
      (file) => file.id === contextTab(),
    );
    if (index < 0) return [];
    return props.state.documents
      .filter((_, position) => {
        switch (scope) {
          case "current":
            return position === index;
          case "others":
            return position !== index;
          case "left":
            return position < index;
          case "right":
            return position > index;
          case "all":
            return true;
        }
      })
      .map((file) => file.id);
  }
  function navigate(event: KeyboardEvent, id: string) {
    const ids = props.state.documents.map((file) => file.id);
    const index = ids.indexOf(id);
    const next =
      event.key === "ArrowLeft"
        ? (index + ids.length - 1) % ids.length
        : event.key === "ArrowRight"
          ? (index + 1) % ids.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? ids.length - 1
              : -1;
    if (next < 0) return;
    event.preventDefault();
    props.onActivate(ids[next]);
    onSettled(() => document.getElementById(tabId(ids[next]))?.focus());
  }
  return (
    <ContextMenu>
      <Show when={props.state.documents.length}>
        <div role="tablist" aria-label="打开的文件" class="editor-tabs">
          <For each={props.state.documents.map((file) => file.id)}>
            {(id) => {
              const file = () =>
                props.state.documents.find((file) => file.id === id)!;
              const selected = () => props.state.activeId === id;
              return (
                <ContextMenuTrigger
                  id={`${tabId(id)}-context`}
                  as="div"
                  class="editor-tab"
                  data-active={selected() ? "true" : "false"}
                  onContextMenu={() => setContextTab(id)}
                  onPointerDown={(event) => {
                    if (
                      event.pointerType === "touch" ||
                      event.pointerType === "pen"
                    )
                      setContextTab(id);
                  }}
                  onMouseDown={(event) => {
                    if (event.button === 1) event.preventDefault();
                  }}
                  onAuxClick={(event) => {
                    if (event.button !== 1) return;
                    event.preventDefault();
                    props.onClose([id]);
                  }}
                >
                  <button
                    id={tabId(id)}
                    type="button"
                    role="tab"
                    class="editor-tab-label"
                    aria-label={file().path}
                    aria-controls={props.panelId}
                    aria-selected={selected() ? "true" : "false"}
                    tabindex={selected() ? 0 : -1}
                    title={file().path}
                    onClick={() => props.onActivate(id)}
                    onKeyDown={(event) => navigate(event, id)}
                  >
                    <FileText size={14} class="shrink-0 text-secondary" />
                    <span class="min-w-0 truncate">
                      {file().path.split("/").pop()}
                    </span>
                    <Show when={file().dirty}>
                      <span class="editor-dirty" aria-label="未保存" />
                    </Show>
                  </button>
                  <button
                    type="button"
                    class="editor-tab-close"
                    aria-label={`关闭 ${file().path}`}
                    disabled={!props.canClose([id])}
                    onClick={() => props.onClose([id])}
                  >
                    <X size={13} />
                  </button>
                </ContextMenuTrigger>
              );
            }}
          </For>
        </div>
      </Show>
      <ContextMenuContent
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (props.state.conflictPrompt) return;
          const id = contextTab();
          const focusId =
            id && props.state.documents.some((file) => file.id === id)
              ? id
              : props.state.activeId;
          if (focusId) document.getElementById(tabId(focusId))?.focus();
        }}
      >
        <For each={menuGroups}>
          {(group, index) => (
            <>
              <Show when={index() > 0}>
                <ContextMenuSeparator />
              </Show>
              <For each={group}>
                {(item) => (
                  <ContextMenuItem
                    disabled={!props.canClose(targets(item.scope))}
                    onSelect={() => props.onClose(targets(item.scope))}
                  >
                    {item.label}
                  </ContextMenuItem>
                )}
              </For>
            </>
          )}
        </For>
      </ContextMenuContent>
    </ContextMenu>
  );
}
