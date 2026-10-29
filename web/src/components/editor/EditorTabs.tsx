import {
  For,
  Show,
  createEffect,
  createSignal,
  onCleanup,
  onSettled,
  untrack,
} from "solid-js";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui";
import { Check, ChevronDown, FileText, X } from "@/components/icons";
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
  let tabList: HTMLDivElement | undefined;
  let tabListObserver: ResizeObserver | undefined;
  let menuAction: (() => void) | undefined;
  const active = () =>
    props.state.documents.find((file) => file.id === props.state.activeId);
  const tabId = (id: string) => `${props.panelId}-${id}`;
  function revealActiveTab() {
    const id = untrack(() =>
      props.state.activeId ? tabId(props.state.activeId) : null,
    );
    if (!tabList?.clientWidth || !id) return;
    const tab = document.getElementById(id)?.parentElement;
    if (!tab) return;
    const viewport = tabList.getBoundingClientRect();
    const bounds = tab.getBoundingClientRect();
    // Only move the tab strip: scrollIntoView can also scroll the document or
    // workspace, and focusing the tab would interrupt an active editor.
    if (bounds.left < viewport.left)
      tabList.scrollLeft += bounds.left - viewport.left;
    else if (bounds.right > viewport.right)
      tabList.scrollLeft += bounds.right - viewport.right;
  }
  createEffect(
    () =>
      JSON.stringify([
        props.state.activeId,
        props.state.activation,
        props.state.documents.map((file) => [
          file.id,
          file.path,
          !!(file.dirty || file.pending),
        ]),
      ]),
    () => onSettled(revealActiveTab),
  );
  onCleanup(() => tabListObserver?.disconnect());
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
    <Show when={props.state.documents.length}>
      <div class="editor-document-navigation">
        <ContextMenu>
          <div
            ref={(element) => {
              tabList = element;
              tabListObserver?.disconnect();
              tabListObserver = new ResizeObserver(revealActiveTab);
              tabListObserver.observe(element);
            }}
            role="tablist"
            aria-label="打开的文件"
            class="editor-tabs"
          >
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
                      <Show when={file().dirty || file().pending}>
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
        <DropdownMenu
          placement="bottom-end"
          gutter={6}
          onOpenChange={(open) => {
            if (open) menuAction = undefined;
          }}
        >
          <DropdownMenuTrigger
            class="editor-open-documents-trigger"
            aria-label="已打开文档"
            title={`已打开文档（${props.state.documents.length}）`}
          >
            <span class="editor-open-documents-title">
              {active()?.path.split("/").pop() ?? "已打开文档"}
            </span>
            <Show when={active()?.dirty || active()?.pending}>
              <span
                class="editor-dirty editor-open-documents-dirty"
                aria-label="未保存"
              />
            </Show>
            <ChevronDown size={14} />
          </DropdownMenuTrigger>
          <DropdownMenuContent
            class="editor-open-documents-menu"
            aria-label="已打开文档"
            onCloseAutoFocus={(event) => {
              // Restore editor focus or open a save-conflict dialog only once
              // the menu's focus trap and trigger restoration have finished.
              const action = menuAction;
              if (action) {
                event.preventDefault();
                menuAction = undefined;
                queueMicrotask(action);
              } else if (props.state.conflictPrompt) event.preventDefault();
            }}
          >
            <div class="editor-open-documents-heading">
              已打开文档 <span>{props.state.documents.length}</span>
            </div>
            <For each={props.state.documents.map((file) => file.id)}>
              {(id) => {
                const file = () =>
                  props.state.documents.find((file) => file.id === id)!;
                return (
                  <div class="editor-open-document-row">
                    <DropdownMenuItem
                      class="editor-open-document-select"
                      textValue={file().path}
                      aria-label={`${file().path}${file().dirty || file().pending ? "，未保存" : ""}`}
                      aria-current={
                        props.state.activeId === id ? "page" : undefined
                      }
                      onSelect={() => {
                        menuAction = () => props.onActivate(id);
                      }}
                    >
                      <span class="editor-open-document-indicator">
                        <Show when={props.state.activeId === id}>
                          <Check size={14} />
                        </Show>
                      </span>
                      <span class="editor-open-document-details">
                        <span class="editor-open-document-path">
                          {file().path}
                        </span>
                        <Show when={file().dirty || file().pending}>
                          <span class="editor-open-document-state">未保存</span>
                        </Show>
                      </span>
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      class="editor-open-document-close"
                      aria-label={`关闭 ${file().path}`}
                      textValue={`关闭 ${file().path}`}
                      disabled={!props.canClose([id])}
                      onSelect={() => {
                        menuAction = () => props.onClose([id]);
                      }}
                    >
                      <X size={15} />
                    </DropdownMenuItem>
                  </div>
                );
              }}
            </For>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </Show>
  );
}
