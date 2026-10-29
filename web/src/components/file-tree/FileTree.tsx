import { downloadBytes } from "@/lib/download";
import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onSettled,
} from "solid-js";
import {
  ChevronDown,
  ChevronRight,
  Folder,
  FolderOpen,
  FileText,
  FilePlus,
  FolderPlus,
  RefreshCw,
  ChevronsUp,
  Scissors,
  Copy,
  ClipboardPaste,
  Pencil,
  Trash2,
  Download,
  Upload,
  Move,
  Link2,
  Ellipsis,
} from "@/components/icons";
import {
  Button,
  IconButton,
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  TextField,
  TextFieldLabel,
  TextFieldInput,
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui";
import { ROOT_PATH, childPath, vaultPath } from "@/lib/vault";
import type { VaultBackend, VaultPath } from "@/lib/vault";
import {
  FileTreeModel,
  entryName,
  parentPath,
  isWithin,
  describeTreeError,
} from "@/lib/file-tree/model";
import type { TreeChange } from "@/lib/file-tree/model";
import type { GitStatusSnapshot } from "@/lib/editor/generated/celestite_core";
import {
  GIT_STATUS_LABELS,
  summarizeGitStatus,
  type GitDisplayStatus,
  type GitStatusSource,
} from "@/lib/git/status";
import { StatusSlot } from "@/components/ui/status-slot";
import { FileQuickOpen } from "./FileQuickOpen";
import "./file-tree.css";

export interface FileTreeActions {
  createNote: () => void;
  focus: () => void;
}

/** 按根目录的写法选择分隔符，把 Vault 相对路径拼成本地绝对路径。 */
function joinRootPath(root: string, path: VaultPath): string {
  const separator = root.includes("\\") && !root.includes("/") ? "\\" : "/";
  const base = root.replace(/[\\/]+$/, "");
  return path ? `${base}${separator}${path.split("/").join(separator)}` : base;
}

export interface FileTreeProps {
  disabled?: boolean;
  readOnly?: boolean;
  backend: VaultBackend;
  model?: FileTreeModel;
  viewState?: { scrollTop: number };
  statusMount?: Element;
  /** Optional read-only Git decoration supplied by the Vault host. */
  git?: GitStatusSource;
  label?: string;
  /** 本地 Vault 的绝对根目录；浏览器或远端 Vault 没有绝对路径时为 null。 */
  rootPath?: string | null;
  onOpen?: (path: VaultPath) => void;
  onChange?: (change: TreeChange) => void;
  onReady?: (actions: FileTreeActions | undefined) => void;
}
type TreeDialog =
  | { kind: "create-note"; parent: VaultPath }
  | { kind: "create-file"; parent: VaultPath }
  | { kind: "create-directory"; parent: VaultPath }
  | { kind: "rename"; path: VaultPath }
  | { kind: "delete"; paths: VaultPath[] }
  | { kind: "move"; paths: VaultPath[] };

/** 后端由父组件关闭；传入模型时状态由 Vault 持有，否则由控件创建并释放。 */
export function FileTree(props: FileTreeProps) {
  const model =
    props.model ??
    new FileTreeModel(props.backend, (change) => props.onChange?.(change));
  const [state, setState] = createSignal(model.snapshot());
  const unsubscribe = model.subscribe(setState);
  const [gitSnapshot, setGitSnapshot] = createSignal<GitStatusSnapshot | null>(
    null,
  );
  const gitView = createMemo(() => summarizeGitStatus(gitSnapshot()));
  let stopGit: (() => void) | undefined;
  const [dialog, setDialog] = createSignal<TreeDialog | null>(null);
  const [dropTarget, setDropTarget] = createSignal<VaultPath | null>(null);
  const [localError, setLocalError] = createSignal<string | null>(null);
  const [notice, setNotice] = createSignal<string | null>(null);
  let noticeTimer: ReturnType<typeof setTimeout> | undefined;
  const id = `file-tree-${crypto.randomUUID()}`;
  const mime = "application/x-celestite-tree";
  let tree!: HTMLDivElement;
  let fileInput!: HTMLInputElement;
  let importParent = ROOT_PATH;
  let dragPaths: VaultPath[] = [];
  let hoverTimer: ReturnType<typeof setTimeout> | undefined;
  let hoverPath: VaultPath | null = null;
  let search = "";
  let searchAt = 0;
  let disposed = false;
  let previousDisabled: boolean | undefined;
  let unwatch: (() => void) | undefined;
  let dialogOpener: HTMLElement | undefined;
  const itemId = (path: VaultPath) => `${id}-${encodeURIComponent(path)}`;
  const canWrite = () =>
    !props.disabled && !props.readOnly && !model.snapshot().busy;
  /**
   * 菜单或弹窗关闭后把焦点还给文件树。Kobalte 的 ContextMenu 在 Esc 关闭时
   * 不触发 onCloseAutoFocus，且浮层卸载可能把焦点落到 body，因此这里同步聚焦
   * 一次、再在下一个宏任务补一次，压过浮层清理阶段的焦点变化。
   */
  const focusTree = () => {
    if (disposed || props.disabled || !tree) return;
    tree.focus();
    setTimeout(() => {
      if (!disposed && !props.disabled) tree?.focus();
    }, 0);
  };
  const closeDialog = () => {
    setDialog(null);
  };
  const announce = (message: string) => {
    setNotice(message);
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => setNotice(null), 2200);
  };
  const requestDialog = (value: TreeDialog) => {
    if (canWrite()) {
      model.clearError();
      setLocalError(null);
      dialogOpener =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : undefined;
      setDialog(value);
    }
  };
  const newParent = () =>
    model.snapshot().selected.size ? model.directoryFor() : ROOT_PATH;
  const requestCreate = (
    kind: "create-file" | "create-directory",
    parent = newParent(),
  ) => requestDialog({ kind, parent });
  const createNote = () =>
    requestDialog({ kind: "create-note", parent: newParent() });
  const selectedPaths = () => model.selection();
  const open = (path: VaultPath) => {
    const row = model.snapshot().rows.find((row) => row.path === path);
    if (row?.kind === "directory") void model.toggle(path);
    else if (row?.kind === "file") props.onOpen?.(path);
  };
  const requestDelete = () => {
    const paths = selectedPaths();
    if (paths.length) requestDialog({ kind: "delete", paths });
  };
  const requestRename = () => {
    const paths = [...model.snapshot().selected];
    if (paths.length === 1) requestDialog({ kind: "rename", path: paths[0] });
  };
  const requestMove = () => {
    const paths = selectedPaths();
    if (paths.length) requestDialog({ kind: "move", paths });
  };
  const copyPaths = (absolute: boolean) => {
    const paths = selectedPaths();
    const root = props.rootPath;
    if (!paths.length || (absolute && !root)) return;
    const text = paths
      .map((path) => (absolute ? joinRootPath(root!, path) : path))
      .join("\n");
    void navigator.clipboard.writeText(text).then(
      () =>
        announce(
          paths.length > 1 ? `已复制 ${paths.length} 个路径` : "已复制路径",
        ),
      () => setLocalError("无法复制路径，请检查剪贴板权限。"),
    );
  };
  const importFiles = (parent: VaultPath) => {
    if (!canWrite()) return;
    importParent = parent;
    fileInput.click();
  };
  const paste = (parent: VaultPath) => {
    if (!canWrite()) return;
    void model.paste(parent).then(focusTree);
  };
  const cut = () => {
    if (canWrite()) model.cutSelection();
  };
  // These operations are the same in the toolbar and context menu; only the
  // destination differs (current selection versus the clicked row/root).
  const creationActions = [
    {
      label: "新建文件",
      icon: FilePlus,
      run: (parent: VaultPath) => requestCreate("create-file", parent),
    },
    {
      label: "新建文件夹",
      icon: FolderPlus,
      run: (parent: VaultPath) => requestCreate("create-directory", parent),
    },
    { label: "导入文件", icon: Upload, run: importFiles },
  ];
  const stopHover = () => {
    clearTimeout(hoverTimer);
    hoverPath = null;
  };
  const clearDropTarget = () => {
    setDropTarget(null);
    stopHover();
  };
  createEffect(
    () => props.disabled,
    (disabled) => {
      const nextDisabled = !!disabled;
      if (nextDisabled === previousDisabled) return;
      const changed = previousDisabled !== undefined;
      previousDisabled = nextDisabled;
      // Context-menu portals live outside the inert workspace. Recreate their
      // owner on connection changes to close them, retaining the tree viewport.
      if (changed) {
        const scrollTop = tree?.scrollTop ?? 0;
        setTimeout(() => {
          if (!disposed && tree) tree.scrollTop = scrollTop;
        }, 0);
      }
      if (disabled) {
        closeDialog();
        clearDropTarget();
        dragPaths = [];
      }
    },
  );
  createEffect(
    () => props.readOnly,
    (readOnly) => {
      if (!readOnly) return;
      closeDialog();
      clearDropTarget();
      dragPaths = [];
      if (model.snapshot().clipboard.mode === "cut") model.cancelCut();
    },
  );
  // Git decoration is best-effort: a slow or failing host must never affect
  // tree input, and the last snapshot stays visible until a new scan succeeds.
  createEffect(
    () => [props.git, !!props.disabled] as const,
    ([source, blocked]) => {
      stopGit?.();
      stopGit = undefined;
      if (!source || blocked) return;
      let stopped = false;
      let inflight = false;
      let again = false;
      const refresh = async () => {
        if (
          stopped ||
          (typeof document !== "undefined" &&
            document.visibilityState === "hidden")
        )
          return;
        if (inflight) {
          again = true;
          return;
        }
        inflight = true;
        try {
          const next = await source.status();
          if (!stopped) setGitSnapshot(next);
        } catch {
          // Decoration is optional; keep the previous view and retry later.
        } finally {
          inflight = false;
          if (again && !stopped) {
            again = false;
            void refresh();
          }
        }
      };
      void refresh();
      const timer = setInterval(() => void refresh(), 3500);
      const focus = () => void refresh();
      const visibility = () => {
        if (document.visibilityState === "visible") void refresh();
      };
      if (typeof window !== "undefined")
        window.addEventListener("focus", focus);
      if (typeof document !== "undefined")
        document.addEventListener("visibilitychange", visibility);
      stopGit = () => {
        stopped = true;
        clearInterval(timer);
        if (typeof window !== "undefined")
          window.removeEventListener("focus", focus);
        if (typeof document !== "undefined")
          document.removeEventListener("visibilitychange", visibility);
      };
    },
  );
  onSettled(() => {
    props.onReady?.({ createNote, focus: focusTree });
    // A new tree already starts at zero. Assigning scrollTop during mounting
    // forces layout before the rest of the workspace has finished rendering.
    if (props.viewState?.scrollTop) tree.scrollTop = props.viewState.scrollTop;
    void model.refresh();
    void props.backend
      .watch(() => model.invalidate())
      .then((stop) => {
        if (disposed) stop();
        else unwatch = stop;
      })
      .catch((error) => {
        if (!disposed) setLocalError(describeTreeError(error));
      });
  });
  onCleanup(() => {
    disposed = true;
    props.onReady?.(undefined);
    stopGit?.();
    unwatch?.();
    unsubscribe();
    if (props.viewState) props.viewState.scrollTop = tree?.scrollTop ?? 0;
    if (!props.model) model.dispose();
    stopHover();
    clearTimeout(noticeTimer);
  });
  createEffect(
    () => state().focused,
    (focused) => {
      if (focused && document.activeElement === tree)
        document
          .getElementById(itemId(focused))
          ?.scrollIntoView({ block: "nearest" });
    },
  );

  async function download(path: VaultPath) {
    try {
      const bytes = await props.backend.readFile(path);
      await downloadBytes(entryName(path), bytes);
    } catch (error) {
      setLocalError(describeTreeError(error));
    }
  }
  function keyboard(event: KeyboardEvent) {
    if (props.disabled || event.target !== tree) return;
    const snapshot = model.snapshot();
    const paths = snapshot.rows.map((row) => row.path);
    const index = paths.indexOf(snapshot.focused ?? ROOT_PATH);
    const command = event.ctrlKey || event.metaKey;
    const navigate = (next: number) => {
      const path = paths[Math.max(0, Math.min(paths.length - 1, next))];
      if (path)
        model.select(path, {
          range: event.shiftKey,
          toggle: command && event.shiftKey,
          focusOnly: command && !event.shiftKey,
        });
    };
    if (command && event.key.toLowerCase() === "a") {
      event.preventDefault();
      model.selectAll();
      return;
    }
    if (command && event.key.toLowerCase() === "x") {
      event.preventDefault();
      cut();
      return;
    }
    if (command && event.key.toLowerCase() === "c") {
      event.preventDefault();
      model.copySelection();
      return;
    }
    if (command && event.key.toLowerCase() === "v") {
      event.preventDefault();
      if (!snapshot.busy) paste(model.directoryFor());
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      model.clearSelection();
      model.cancelCut();
      return;
    }
    if (event.key === "F2") {
      event.preventDefault();
      requestRename();
      return;
    }
    if (event.key === "Delete") {
      event.preventDefault();
      requestDelete();
      return;
    }
    if (event.key === "F5") {
      event.preventDefault();
      void model.refresh();
      return;
    }
    if (
      (event.shiftKey && event.key === "F10") ||
      event.key === "ContextMenu"
    ) {
      event.preventDefault();
      const element = snapshot.focused
        ? document
            .getElementById(itemId(snapshot.focused))
            ?.querySelector<HTMLElement>(".tree-row")
        : tree;
      const rect = element?.getBoundingClientRect();
      element?.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          button: 2,
          clientX: (rect?.left ?? 0) + 32,
          clientY: (rect?.top ?? 0) + 16,
        }),
      );
      return;
    }
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      navigate(
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? paths.length - 1
            : index + (event.key === "ArrowDown" ? 1 : -1),
      );
      return;
    }
    if (!snapshot.focused) return;
    const focused = snapshot.focused;
    const row = snapshot.rows.find((row) => row.path === focused)!;
    if (event.key === "ArrowRight") {
      event.preventDefault();
      if (row.kind === "directory") {
        if (!snapshot.expanded.has(focused)) void model.toggle(focused);
        else if (paths[index + 1] && parentPath(paths[index + 1]) === focused)
          navigate(index + 1);
      }
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      if (snapshot.expanded.has(focused)) void model.toggle(focused);
      else if (row.parent !== ROOT_PATH)
        model.select(row.parent, { focusOnly: command });
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (!snapshot.busy) open(focused);
    } else if (event.key === " ") {
      event.preventDefault();
      model.select(focused, { toggle: !event.shiftKey, range: event.shiftKey });
    } else if (!command && !event.altKey && event.key.length === 1) {
      event.preventDefault();
      const now = Date.now();
      search = now - searchAt < 700 ? search + event.key : event.key;
      searchAt = now;
      const ordered = [...paths.slice(index + 1), ...paths.slice(0, index + 1)];
      const match = ordered.find((path) =>
        entryName(path)
          .toLocaleLowerCase()
          .startsWith(search.toLocaleLowerCase()),
      );
      if (match) model.select(match);
    }
  }
  function accepts(event: DragEvent, parent: VaultPath) {
    if (!canWrite()) return false;
    if (dragPaths.length) return model.canMove(dragPaths, parent);
    return Array.from(event.dataTransfer?.types ?? []).includes("Files");
  }
  function dragOver(event: DragEvent, parent: VaultPath, folder?: VaultPath) {
    event.stopPropagation();
    if (!accepts(event, parent)) {
      if (event.dataTransfer) event.dataTransfer.dropEffect = "none";
      clearDropTarget();
      return;
    }
    event.preventDefault();
    if (event.dataTransfer)
      event.dataTransfer.dropEffect = dragPaths.length ? "move" : "copy";
    setDropTarget(parent);
    const rect = tree.getBoundingClientRect();
    if (event.clientY < rect.top + 30) tree.scrollTop -= 12;
    else if (event.clientY > rect.bottom - 30) tree.scrollTop += 12;
    if ((folder ?? null) !== hoverPath) {
      stopHover();
      hoverPath = folder ?? null;
      if (folder && !model.snapshot().expanded.has(folder))
        hoverTimer = setTimeout(() => {
          void model.toggle(folder);
        }, 650);
    }
  }
  function drop(event: DragEvent, parent: VaultPath) {
    event.preventDefault();
    event.stopPropagation();
    clearDropTarget();
    if (!accepts(event, parent)) return;
    if (dragPaths.length) {
      // 只接受本控件生成的载荷，避免把其他 Vault 的路径当成本 Vault 路径。
      if (event.dataTransfer?.getData(mime) === id)
        void model.move(dragPaths, parent).then(focusTree);
    } else {
      if (
        Array.from(event.dataTransfer?.items ?? []).some(
          (item) => item.webkitGetAsEntry?.()?.isDirectory,
        )
      ) {
        setLocalError(
          "请使用“导入文件”选择文件；暂不支持从系统拖入整个文件夹。",
        );
        return;
      }
      const files = Array.from(event.dataTransfer?.files ?? []);
      if (files.length) void model.importFiles(files, parent).then(focusTree);
    }
    dragPaths = [];
  }

  // Menu presentation only: selection and operation eligibility remain owned by
  // the model and the call site, rather than a second command/state registry.
  function MenuAction(action: {
    icon: typeof FilePlus;
    label: string;
    shortcut?: string;
    disabled?: boolean;
    danger?: boolean;
    onSelect: () => void;
  }) {
    return (
      <ContextMenuItem
        class={action.danger ? "text-danger" : undefined}
        disabled={state().busy || action.disabled}
        onSelect={action.onSelect}
      >
        <action.icon size={15} />
        {action.label}
        <Show when={action.shortcut}>
          <span class="ml-auto text-ui-sm text-secondary">
            {action.shortcut}
          </span>
        </Show>
      </ContextMenuItem>
    );
  }
  function MenuItems(menuProps: { path?: VaultPath }) {
    const destination = () =>
      menuProps.path ? model.directoryFor(menuProps.path) : ROOT_PATH;
    return (
      <>
        <For each={creationActions}>
          {(action) => (
            <MenuAction
              icon={action.icon}
              label={action.icon === Upload ? `${action.label}…` : action.label}
              disabled={props.readOnly}
              onSelect={() => action.run(destination())}
            />
          )}
        </For>
        <ContextMenuSeparator />
        <Show when={menuProps.path}>
          <For
            each={[
              {
                icon: FileText,
                label: "打开",
                shortcut: "Enter",
                onSelect: () => open(menuProps.path!),
              },
              {
                icon: Pencil,
                label: "重命名…",
                shortcut: "F2",
                disabled: props.readOnly,
                onSelect: requestRename,
              },
            ]}
          >
            {(action) => (
              <MenuAction
                {...action}
                disabled={state().selected.size !== 1 || action.disabled}
              />
            )}
          </For>
          <For
            each={[
              {
                icon: Scissors,
                label: "剪切",
                shortcut: "Ctrl X",
                disabled: props.readOnly,
                onSelect: cut,
              },
              {
                icon: Copy,
                label: "复制",
                shortcut: "Ctrl C",
                onSelect: () => model.copySelection(),
              },
            ]}
          >
            {(action) => (
              <MenuAction
                {...action}
                disabled={!state().selected.size || action.disabled}
              />
            )}
          </For>
          <MenuAction
            icon={Link2}
            label="复制相对路径"
            disabled={!state().selected.size}
            onSelect={() => copyPaths(false)}
          />
          <Show when={props.rootPath}>
            <MenuAction
              icon={Link2}
              label="复制绝对路径"
              disabled={!state().selected.size}
              onSelect={() => copyPaths(true)}
            />
          </Show>
          <MenuAction
            icon={Move}
            label="移动到…"
            disabled={props.readOnly || !state().selected.size}
            onSelect={requestMove}
          />
        </Show>
        <MenuAction
          icon={ClipboardPaste}
          label="粘贴"
          shortcut="Ctrl V"
          disabled={props.readOnly || !state().clipboard.count}
          onSelect={() => paste(destination())}
        />
        <Show
          when={
            menuProps.path &&
            state().byPath.get(menuProps.path)?.kind === "file"
          }
        >
          <MenuAction
            icon={Download}
            label="下载"
            disabled={state().selected.size !== 1}
            onSelect={() => void download(menuProps.path!)}
          />
        </Show>
        <Show when={menuProps.path}>
          <ContextMenuSeparator />
          <MenuAction
            icon={Trash2}
            label="删除…"
            shortcut="Del"
            danger
            disabled={props.readOnly || !state().selected.size}
            onSelect={requestDelete}
          />
        </Show>
        <ContextMenuSeparator />
        <MenuAction
          icon={RefreshCw}
          label="刷新"
          onSelect={() => void model.refresh()}
        />
      </>
    );
  }
  function Branch(branchProps: { parent: VaultPath }) {
    return (
      <For each={state().groups.get(branchProps.parent) ?? []}>
        {(path) => <Row path={path} />}
      </For>
    );
  }
  function Row(rowProps: { path: VaultPath }) {
    const row = () => state().byPath.get(rowProps.path)!;
    const expanded = () => state().expanded.has(rowProps.path);
    const directory = () => row()?.kind === "directory";
    const destination = () =>
      directory() ? rowProps.path : parentPath(rowProps.path);
    const gitStatus = (): GitDisplayStatus | undefined =>
      (directory() ? gitView().directories : gitView().files).get(
        rowProps.path,
      );
    const gitLabel = () => {
      const status = gitStatus();
      return status ? GIT_STATUS_LABELS[status] : undefined;
    };
    const rowLabel = () => {
      const label = gitLabel();
      return label
        ? `${entryName(rowProps.path)}（${label}）`
        : entryName(rowProps.path);
    };
    let pointer: { x: number; y: number } | null = null;
    return (
      <ContextMenu
        onOpenChange={(opened) => {
          if (opened && !props.disabled) model.contextSelect(rowProps.path);
          else if (!dialog()) focusTree();
        }}
      >
        <div
          role="treeitem"
          id={itemId(rowProps.path)}
          aria-label={rowLabel()}
          aria-selected={state().selected.has(rowProps.path) ? "true" : "false"}
          aria-expanded={
            directory() ? (expanded() ? "true" : "false") : undefined
          }
          aria-level={row()?.level}
          aria-posinset={row()?.position}
          aria-setsize={row()?.siblings}
          data-drop={
            directory() && dropTarget() === rowProps.path ? "true" : "false"
          }
          style={{
            "--tree-drop-inset": `${4 + ((row()?.level ?? 1) - 1) * 18}px`,
          }}
        >
          <ContextMenuTrigger
            disabled={props.disabled}
            as="div"
            class="tree-row"
            title={
              gitLabel() ? `${rowProps.path} · ${gitLabel()}` : rowProps.path
            }
            tabindex={-1}
            data-path={rowProps.path}
            data-git={gitStatus() ?? "none"}
            data-selected={
              state().selected.has(rowProps.path) ? "true" : "false"
            }
            data-focused={state().focused === rowProps.path ? "true" : "false"}
            data-cut={
              [...state().cut].some((path) => isWithin(rowProps.path, path))
                ? "true"
                : "false"
            }
            style={{
              "padding-left": `${8 + ((row()?.level ?? 1) - 1) * 18}px`,
            }}
            draggable={
              state().busy || props.readOnly || props.disabled
                ? "false"
                : "true"
            }
            onClick={(event) => {
              event.stopPropagation();
              const modifier = event.ctrlKey || event.metaKey || event.shiftKey;
              model.select(rowProps.path, {
                toggle: event.ctrlKey || event.metaKey,
                range: event.shiftKey,
              });
              tree.focus();
              // 单击即打开/折叠，与 Zed 的 project panel 一致；拖动产生的位置
              // 变化不算单击，避免移动文件后顺带打开或折叠目标。
              const dragged =
                pointer !== null &&
                (Math.abs(event.clientX - pointer.x) > 4 ||
                  Math.abs(event.clientY - pointer.y) > 4);
              if (
                !modifier &&
                !dragged &&
                event.button === 0 &&
                !model.snapshot().busy
              )
                open(rowProps.path);
            }}
            onContextMenu={(event) => {
              event.stopPropagation();
              model.contextSelect(rowProps.path);
            }}
            onPointerDown={(event) => {
              pointer = { x: event.clientX, y: event.clientY };
              event.stopPropagation();
            }}
            onPointerMove={(event) => event.stopPropagation()}
            onPointerUp={(event) => event.stopPropagation()}
            onPointerCancel={(event) => event.stopPropagation()}
            onDragStart={(event) => {
              clearDropTarget();
              if (!canWrite()) {
                event.preventDefault();
                return;
              }
              if (!model.snapshot().selected.has(rowProps.path))
                model.select(rowProps.path);
              dragPaths = model.selection();
              event.dataTransfer?.setData(mime, id);
              event.dataTransfer?.setData("text/plain", dragPaths.join("\n"));
              if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
            }}
            onDragEnd={() => {
              dragPaths = [];
              clearDropTarget();
            }}
            onDragOver={(event) =>
              dragOver(
                event,
                destination(),
                directory() ? rowProps.path : undefined,
              )
            }
            onDrop={(event) => drop(event, destination())}
          >
            <Show
              when={directory()}
              fallback={<span class="tree-chevron-spacer" />}
            >
              <button
                type="button"
                tabindex={-1}
                class="tree-chevron"
                aria-label={`${expanded() ? "折叠" : "展开"} ${entryName(rowProps.path)}`}
                disabled={state().busy}
                onClick={(event) => {
                  event.stopPropagation();
                  model.select(rowProps.path, { focusOnly: true });
                  void model.toggle(rowProps.path);
                  tree.focus();
                }}
              >
                <Show when={expanded()} fallback={<ChevronRight size={14} />}>
                  <ChevronDown size={14} />
                </Show>
              </button>
            </Show>
            <Show
              when={directory()}
              fallback={<FileText size={16} class="text-secondary" />}
            >
              <Show
                when={expanded()}
                fallback={<Folder size={16} class="text-secondary" />}
              >
                <FolderOpen size={16} class="text-secondary" />
              </Show>
            </Show>
            <span class="tree-name min-w-0 truncate">
              {entryName(rowProps.path)}
            </span>
          </ContextMenuTrigger>
          <Show when={directory() && expanded()}>
            <div role="group">
              <Branch parent={rowProps.path} />
            </div>
          </Show>
        </div>
        <ContextMenuContent
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (!dialog()) focusTree();
          }}
        >
          <MenuItems path={rowProps.path} />
        </ContextMenuContent>
      </ContextMenu>
    );
  }
  function OperationDialog(dialogProps: { value: TreeDialog }) {
    let input!: HTMLInputElement;
    let openedNote = false;
    const value = dialogProps.value;
    const opener = dialogOpener;
    const restoreFocus = () => {
      if (
        value.kind !== "create-note" ||
        !opener?.isConnected ||
        !opener.getClientRects().length
      ) {
        focusTree();
        return;
      }
      opener.focus();
      setTimeout(() => {
        if (
          !disposed &&
          !dialog() &&
          opener.isConnected &&
          opener.getClientRects().length
        )
          opener.focus();
      }, 0);
    };
    const title =
      value.kind === "delete"
        ? `删除 ${value.paths.length} 项`
        : value.kind === "rename"
          ? "重命名"
          : value.kind === "move"
            ? "移动到文件夹"
            : value.kind === "create-note"
              ? "新建笔记"
              : value.kind === "create-file"
                ? "新建文件"
                : "新建文件夹";
    const initial =
      value.kind === "rename"
        ? entryName(value.path)
        : value.kind === "create-note"
          ? "未命名"
          : value.kind === "create-file"
            ? "未命名"
            : value.kind === "create-directory"
              ? "新建文件夹"
              : "";
    onSettled(() => {
      if (input) {
        input.focus();
        input.setSelectionRange(
          0,
          value.kind === "rename" &&
            state().byPath.get(value.path)?.kind === "file" &&
            initial.lastIndexOf(".") > 0
            ? initial.lastIndexOf(".")
            : initial.length,
        );
      }
    });
    const submit = async (event: SubmitEvent) => {
      event.preventDefault();
      if (!canWrite()) return;
      setLocalError(null);
      const entered =
        value.kind === "create-note"
          ? (input?.value ?? "").trim()
          : (input?.value ?? "");
      if (value.kind === "create-note" && !entered) {
        setLocalError("请输入笔记标题。");
        input.focus();
        return;
      }
      const name =
        value.kind === "create-note" && entered && !/\.md$/i.test(entered)
          ? `${entered}.md`
          : entered;
      let result = false;
      if (value.kind === "delete") result = await model.remove(value.paths);
      else if (value.kind === "move") {
        try {
          result = await model.move(value.paths, vaultPath(name));
        } catch (error) {
          setLocalError(describeTreeError(error));
        }
      } else if (value.kind === "rename")
        result = await model.rename(value.path, name);
      else
        result = await model.create(
          value.parent,
          name,
          value.kind === "create-directory" ? "directory" : "file",
        );
      if (result) {
        openedNote = value.kind === "create-note";
        closeDialog();
        if (value.kind === "create-note")
          props.onOpen?.(childPath(value.parent, name));
        else focusTree();
      }
    };
    return (
      <DialogContent
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (!openedNote) restoreFocus();
        }}
      >
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>
          {value.kind === "delete"
            ? "文件夹内的全部内容也会删除。此操作无法撤销。"
            : value.kind === "move"
              ? "填写 Vault 内的文件夹路径，留空表示根目录。已有文件不会被覆盖。"
              : value.kind === "rename"
                ? value.path
                : value.kind === "create-note"
                  ? `保存为 Markdown 笔记 · 位置：${value.parent || props.label || "Vault"}`
                  : `位置：${value.parent || props.label || "Vault"}`}
        </DialogDescription>
        <form
          onSubmit={(event) => void submit(event)}
          class="mt-5 flex flex-col gap-4"
        >
          <Show when={value.kind === "delete" || value.kind === "move"}>
            <ul class="m-0 max-h-36 overflow-auto pl-5 text-ui-sm text-secondary">
              <For each={(value as { paths: VaultPath[] }).paths}>
                {(path) => <li class="break-all">{path}</li>}
              </For>
            </ul>
          </Show>
          <Show when={value.kind !== "delete"}>
            <TextField defaultValue={initial}>
              <TextFieldLabel>
                {value.kind === "move"
                  ? "目标文件夹路径"
                  : value.kind === "create-note"
                    ? "笔记标题"
                    : "名称"}
              </TextFieldLabel>
              <TextFieldInput
                ref={input}
                required={value.kind !== "move"}
                disabled={state().busy}
                autofocus
                autocomplete="off"
              />
            </TextField>
          </Show>
          <Show when={state().error || localError()}>
            <p role="alert" class="text-ui-sm text-danger">
              {localError() || state().error}
            </p>
          </Show>
          <div class="flex justify-end gap-2">
            <Button
              disabled={state().busy}
              onClick={() => {
                closeDialog();
                restoreFocus();
              }}
            >
              取消
            </Button>
            <Button
              type="submit"
              variant={value.kind === "delete" ? "danger" : "primary"}
              disabled={state().busy}
            >
              {state().busy
                ? "处理中…"
                : value.kind === "delete"
                  ? "删除"
                  : "确认"}
            </Button>
          </div>
        </form>
      </DialogContent>
    );
  }

  return (
    <section
      class="file-tree"
      aria-label={`${props.label ?? "Vault"} 文件浏览器`}
      onDragOver={(event) => {
        // Rows and the root stop propagation. Toolbar/footer are not drop zones.
        if (event.dataTransfer) event.dataTransfer.dropEffect = "none";
        clearDropTarget();
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null))
          clearDropTarget();
      }}
    >
      <div class="tree-navigation-actions">
        <FileQuickOpen
          backend={props.backend}
          entries={state().rows}
          disabled={props.disabled}
          onOpen={props.onOpen}
        />
        <Button
          class="tree-new-note"
          variant="ghost"
          disabled={state().busy || props.disabled || props.readOnly}
          onClick={createNote}
        >
          <FilePlus size={16} />
          <span>新建笔记</span>
        </Button>
      </div>
      <div
        class="tree-region"
        data-drop={dropTarget() === ROOT_PATH ? "true" : "false"}
      >
        <header
          class="tree-toolbar tree-root"
          onDragOver={(event) => dragOver(event, ROOT_PATH)}
          onDrop={(event) => drop(event, ROOT_PATH)}
        >
          <span class="tree-heading-label">文件</span>
          <span class="tree-root-count">
            {state().rows.filter((row) => row.parent === ROOT_PATH).length}
          </span>
          <Show when={props.readOnly}>
            <span class="tree-readonly">只读</span>
          </Show>
          <Show when={props.disabled ? "disabled" : "enabled"} keyed>
            {(_connectionState) => (
              <DropdownMenu placement="bottom-end" gutter={6}>
                <DropdownMenuTrigger
                  as={IconButton}
                  aria-label="文件操作"
                  title="文件操作"
                  size="sm"
                  disabled={state().busy || props.disabled}
                >
                  <Ellipsis size={16} />
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  onCloseAutoFocus={(event) => {
                    if (dialog()) event.preventDefault();
                  }}
                >
                  <For each={creationActions}>
                    {(action) => (
                      <DropdownMenuItem
                        disabled={state().busy || props.readOnly}
                        onSelect={() => action.run(newParent())}
                      >
                        <action.icon size={15} />
                        {action.label}
                      </DropdownMenuItem>
                    )}
                  </For>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    disabled={state().busy}
                    onSelect={() => model.collapseAll()}
                  >
                    <ChevronsUp size={15} />
                    折叠全部
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={state().busy}
                    onSelect={() => void model.refresh()}
                  >
                    <RefreshCw size={15} />
                    刷新文件树
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </Show>
        </header>
        <Show when={props.disabled ? "disabled" : "enabled"} keyed>
          {(_connectionState) => (
            <ContextMenu
              onOpenChange={(opened) => {
                if (opened && !props.disabled) model.clearSelection(true);
                else if (!dialog()) focusTree();
              }}
            >
              <ContextMenuTrigger
                disabled={props.disabled}
                as="div"
                role="tree"
                aria-label="文件树"
                aria-multiselectable="true"
                aria-busy={state().busy ? "true" : "false"}
                aria-activedescendant={
                  state().focused ? itemId(state().focused!) : undefined
                }
                aria-describedby={`${id}-help`}
                ref={tree}
                tabindex={0}
                class="tree-body"
                onKeyDown={keyboard}
                onClick={() => {
                  model.clearSelection(true);
                  tree.focus();
                }}
                onContextMenu={() => model.clearSelection(true)}
                onDragOver={(event: DragEvent) => dragOver(event, ROOT_PATH)}
                onDrop={(event: DragEvent) => drop(event, ROOT_PATH)}
              >
                <Branch parent={ROOT_PATH} />
                <Show when={!state().rows.length}>
                  <div class="px-5 py-8 text-center text-ui-sm text-secondary">
                    {state().busy ? "正在读取…" : "这里还没有文件"}
                    <p class="mt-2">
                      {props.readOnly
                        ? "此文件库仅供查看"
                        : "新建笔记，或把文件拖到这里"}
                    </p>
                  </div>
                </Show>
              </ContextMenuTrigger>
              <ContextMenuContent
                onCloseAutoFocus={(event) => {
                  event.preventDefault();
                  if (!dialog()) focusTree();
                }}
              >
                <MenuItems />
              </ContextMenuContent>
            </ContextMenu>
          )}
        </Show>
      </div>
      <Show when={!dialog() && (state().error || localError())}>
        <div
          role="alert"
          class="border-t border-solid border-border px-3 py-2 text-ui-sm text-danger"
        >
          {localError() || state().error}
          <Button
            size="sm"
            variant="ghost"
            class="mt-1"
            disabled={state().busy}
            onClick={() => {
              setLocalError(null);
              void model.refresh();
            }}
          >
            重新读取
          </Button>
        </div>
      </Show>
      <StatusSlot mount={props.statusMount} class="tree-footer">
        <p
          role="status"
          aria-label="文件树状态"
          aria-live="polite"
          class="truncate"
        >
          {state().busy
            ? state().status
            : (notice() ??
              (state().clipboard.count
                ? `已${state().clipboard.mode === "cut" ? "剪切" : "复制"} ${state().clipboard.count} 项`
                : state().selected.size
                  ? `已选择 ${state().selected.size} 项`
                  : state().status))}
        </p>
      </StatusSlot>
      <p id={`${id}-help`} class="sr-only">
        单击打开 · Ctrl / ⌘ 多选 · Shift 连选
        {props.readOnly ? " · 只读文件库" : " · 拖入文件夹移动"}
      </p>
      <input
        ref={fileInput}
        type="file"
        multiple
        class="hidden"
        aria-label="选择要导入的文件"
        disabled={props.disabled || props.readOnly}
        onChange={(event) => {
          const files = Array.from(event.currentTarget.files ?? []);
          event.currentTarget.value = "";
          if (files.length && canWrite())
            void model.importFiles(files, importParent).then(focusTree);
        }}
      />
      <Dialog
        open={!!dialog()}
        onOpenChange={(open) => {
          if (!open && !model.snapshot().busy) closeDialog();
        }}
      >
        <Show when={dialog()} keyed>
          {(value) => <OperationDialog value={value} />}
        </Show>
      </Dialog>
    </section>
  );
}
