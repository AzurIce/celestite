import {
  For,
  Show,
  createEffect,
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
} from "@/components/ui";
import { ROOT_PATH, vaultPath } from "@/lib/vault";
import type { VaultBackend, VaultPath } from "@/lib/vault";
import {
  FileTreeModel,
  entryName,
  parentPath,
  isWithin,
  describeTreeError,
} from "@/lib/file-tree/model";
import type { TreeChange } from "@/lib/file-tree/model";
import "./file-tree.css";

export interface FileTreeProps {
  backend: VaultBackend;
  label?: string;
  onOpen?: (path: VaultPath) => void;
  onChange?: (change: TreeChange) => void;
}
type TreeDialog =
  | { kind: "create-file"; parent: VaultPath }
  | { kind: "create-directory"; parent: VaultPath }
  | { kind: "rename"; path: VaultPath }
  | { kind: "delete"; paths: VaultPath[] }
  | { kind: "move"; paths: VaultPath[] };

/** 后端由父组件持有并关闭；每个控件拥有独立的展开、选择和剪切状态。 */
export function FileTree(props: FileTreeProps) {
  const model = new FileTreeModel(props.backend, (change) =>
    props.onChange?.(change),
  );
  const [state, setState] = createSignal(model.snapshot());
  const unsubscribe = model.subscribe(setState);
  const [dialog, setDialog] = createSignal<TreeDialog | null>(null);
  const [dropTarget, setDropTarget] = createSignal<VaultPath | null>(null);
  const [localError, setLocalError] = createSignal<string | null>(null);
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
  let dialogActive = false;
  let unwatch: (() => void) | undefined;
  const itemId = (path: VaultPath) => `${id}-${encodeURIComponent(path)}`;
  const focusTree = () =>
    onSettled(() => {
      if (!disposed) tree?.focus();
    });
  const closeDialog = () => {
    dialogActive = false;
    setDialog(null);
  };
  const requestDialog = (value: TreeDialog) => {
    if (!model.snapshot().busy) {
      model.clearError();
      setLocalError(null);
      dialogActive = true;
      setDialog(value);
    }
  };
  const newParent = () =>
    model.snapshot().selected.size ? model.directoryFor() : ROOT_PATH;
  const requestCreate = (
    kind: "create-file" | "create-directory",
    parent = newParent(),
  ) => requestDialog({ kind, parent });
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
  const importFiles = (parent: VaultPath) => {
    importParent = parent;
    fileInput.click();
  };
  const paste = (parent: VaultPath) => {
    void model.paste(parent).then(focusTree);
  };
  const stopHover = () => {
    clearTimeout(hoverTimer);
    hoverPath = null;
  };
  const clearDropTarget = () => {
    setDropTarget(null);
    stopHover();
  };
  onSettled(() => {
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
    unwatch?.();
    unsubscribe();
    model.dispose();
    stopHover();
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
      const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)]));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = entryName(path);
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      setLocalError(describeTreeError(error));
    }
  }
  function keyboard(event: KeyboardEvent) {
    if (event.target !== tree) return;
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
      model.cutSelection();
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
    if (model.snapshot().busy) return false;
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

  function MenuItems(menuProps: { path?: VaultPath }) {
    const destination = () =>
      menuProps.path ? model.directoryFor(menuProps.path) : ROOT_PATH;
    return (
      <>
        <ContextMenuItem
          disabled={state().busy}
          onSelect={() => requestCreate("create-file", destination())}
        >
          <FilePlus size={15} />
          新建文件
        </ContextMenuItem>
        <ContextMenuItem
          disabled={state().busy}
          onSelect={() => requestCreate("create-directory", destination())}
        >
          <FolderPlus size={15} />
          新建文件夹
        </ContextMenuItem>
        <ContextMenuItem
          disabled={state().busy}
          onSelect={() => importFiles(destination())}
        >
          <Upload size={15} />
          导入文件…
        </ContextMenuItem>
        <ContextMenuSeparator />
        <Show when={menuProps.path}>
          <ContextMenuItem
            disabled={state().busy || state().selected.size !== 1}
            onSelect={() => open(menuProps.path!)}
          >
            <FileText size={15} />
            打开<span class="ml-auto text-ui-sm text-secondary">Enter</span>
          </ContextMenuItem>
          <ContextMenuItem
            disabled={state().busy || state().selected.size !== 1}
            onSelect={requestRename}
          >
            <Pencil size={15} />
            重命名…<span class="ml-auto text-ui-sm text-secondary">F2</span>
          </ContextMenuItem>
          <ContextMenuItem
            disabled={state().busy || !state().selected.size}
            onSelect={() => model.cutSelection()}
          >
            <Scissors size={15} />
            剪切<span class="ml-auto text-ui-sm text-secondary">Ctrl X</span>
          </ContextMenuItem>
          <ContextMenuItem
            disabled={state().busy || !state().selected.size}
            onSelect={() => model.copySelection()}
          >
            <Copy size={15} />
            复制<span class="ml-auto text-ui-sm text-secondary">Ctrl C</span>
          </ContextMenuItem>
          <ContextMenuItem
            disabled={state().busy || !state().selected.size}
            onSelect={requestMove}
          >
            <Move size={15} />
            移动到…
          </ContextMenuItem>
        </Show>
        <ContextMenuItem
          disabled={state().busy || !state().clipboard.count}
          onSelect={() => paste(destination())}
        >
          <ClipboardPaste size={15} />
          粘贴<span class="ml-auto text-ui-sm text-secondary">Ctrl V</span>
        </ContextMenuItem>
        <Show
          when={
            menuProps.path &&
            state().byPath.get(menuProps.path)?.kind === "file"
          }
        >
          <ContextMenuItem
            disabled={state().busy || state().selected.size !== 1}
            onSelect={() => void download(menuProps.path!)}
          >
            <Download size={15} />
            下载
          </ContextMenuItem>
        </Show>
        <Show when={menuProps.path}>
          <ContextMenuSeparator />
          <ContextMenuItem
            class="text-danger"
            disabled={state().busy || !state().selected.size}
            onSelect={requestDelete}
          >
            <Trash2 size={15} />
            删除…<span class="ml-auto text-ui-sm text-secondary">Del</span>
          </ContextMenuItem>
        </Show>
        <ContextMenuSeparator />
        <ContextMenuItem
          disabled={state().busy}
          onSelect={() => void model.refresh()}
        >
          <RefreshCw size={15} />
          刷新
        </ContextMenuItem>
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
    return (
      <ContextMenu
        onOpenChange={(opened) => {
          if (opened) model.contextSelect(rowProps.path);
        }}
      >
        <div
          role="treeitem"
          id={itemId(rowProps.path)}
          aria-label={entryName(rowProps.path)}
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
            as="div"
            class="tree-row"
            title={rowProps.path}
            tabindex={-1}
            data-path={rowProps.path}
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
            draggable={state().busy ? "false" : "true"}
            onClick={(event) => {
              event.stopPropagation();
              model.select(rowProps.path, {
                toggle: event.ctrlKey || event.metaKey,
                range: event.shiftKey,
              });
              tree.focus();
            }}
            onDblClick={(event) => {
              event.stopPropagation();
              if (!model.snapshot().busy) open(rowProps.path);
            }}
            onContextMenu={(event) => {
              event.stopPropagation();
              model.contextSelect(rowProps.path);
            }}
            onPointerDown={(event) => event.stopPropagation()}
            onPointerMove={(event) => event.stopPropagation()}
            onPointerUp={(event) => event.stopPropagation()}
            onPointerCancel={(event) => event.stopPropagation()}
            onDragStart={(event) => {
              clearDropTarget();
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
            <Show when={directory()} fallback={<span class="w-5 shrink-0" />}>
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
                fallback={<Folder size={16} class="text-accent" />}
              >
                <FolderOpen size={16} class="text-accent" />
              </Show>
            </Show>
            <span class="min-w-0 truncate">{entryName(rowProps.path)}</span>
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
            if (!dialogActive) focusTree();
          }}
        >
          <MenuItems path={rowProps.path} />
        </ContextMenuContent>
      </ContextMenu>
    );
  }
  function OperationDialog(dialogProps: { value: TreeDialog }) {
    let input!: HTMLInputElement;
    const value = dialogProps.value;
    const title =
      value.kind === "delete"
        ? `删除 ${value.paths.length} 项`
        : value.kind === "rename"
          ? "重命名"
          : value.kind === "move"
            ? "移动到文件夹"
            : value.kind === "create-file"
              ? "新建文件"
              : "新建文件夹";
    const initial =
      value.kind === "rename"
        ? entryName(value.path)
        : value.kind === "create-file"
          ? "未命名.md"
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
      setLocalError(null);
      const name = input?.value ?? "";
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
          value.kind === "create-file" ? "file" : "directory",
        );
      if (result) {
        closeDialog();
        focusTree();
      }
    };
    return (
      <DialogContent
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          focusTree();
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
                {value.kind === "move" ? "目标文件夹路径" : "名称"}
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
                focusTree();
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
      <header class="flex items-center gap-1 border-b border-solid border-border px-2 py-2">
        <span class="mr-auto truncate px-1 font-semibold text-ui-sm">文件</span>
        <IconButton
          aria-label="新建文件"
          title="新建文件"
          size="sm"
          disabled={state().busy}
          onClick={() => requestCreate("create-file")}
        >
          <FilePlus size={16} />
        </IconButton>
        <IconButton
          aria-label="新建文件夹"
          title="新建文件夹"
          size="sm"
          disabled={state().busy}
          onClick={() => requestCreate("create-directory")}
        >
          <FolderPlus size={16} />
        </IconButton>
        <IconButton
          aria-label="导入文件"
          title="导入文件"
          size="sm"
          disabled={state().busy}
          onClick={() => importFiles(newParent())}
        >
          <Upload size={16} />
        </IconButton>
        <IconButton
          aria-label="折叠全部"
          title="折叠全部"
          size="sm"
          disabled={state().busy}
          onClick={() => model.collapseAll()}
        >
          <ChevronsUp size={16} />
        </IconButton>
        <IconButton
          aria-label="刷新文件树"
          title="刷新文件树"
          size="sm"
          disabled={state().busy}
          onClick={() => void model.refresh()}
        >
          <RefreshCw size={16} />
        </IconButton>
      </header>
      <div
        class="tree-region"
        data-drop={dropTarget() === ROOT_PATH ? "true" : "false"}
      >
        <div
          class="tree-root"
          onDragOver={(event) => dragOver(event, ROOT_PATH)}
          onDrop={(event) => drop(event, ROOT_PATH)}
        >
          <FolderOpen size={16} />
          <span class="truncate font-medium">{props.label ?? "Vault"}</span>
          <span class="ml-auto text-ui-sm text-secondary">
            {state().rows.filter((row) => row.parent === ROOT_PATH).length}
          </span>
        </div>
        <ContextMenu
          onOpenChange={(opened) => {
            if (opened) model.clearSelection(true);
          }}
        >
          <ContextMenuTrigger
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
                <p class="mt-2">新建文件，或把文件拖到这里</p>
              </div>
            </Show>
          </ContextMenuTrigger>
          <ContextMenuContent
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              if (!dialogActive) focusTree();
            }}
          >
            <MenuItems />
          </ContextMenuContent>
        </ContextMenu>
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
      <footer class="border-t border-solid border-border px-3 py-2 text-ui-sm text-secondary">
        <p role="status" aria-live="polite" class="truncate">
          {state().busy
            ? state().status
            : state().clipboard.count
              ? `已${state().clipboard.mode === "cut" ? "剪切" : "复制"} ${state().clipboard.count} 项`
              : state().selected.size
                ? `已选择 ${state().selected.size} 项`
                : state().status}
        </p>
        <p id={`${id}-help`} class="mt-1 text-[11px]">
          Ctrl / ⌘ 多选 · Shift 连选 · 拖入文件夹移动
        </p>
      </footer>
      <input
        ref={fileInput}
        type="file"
        multiple
        class="hidden"
        aria-label="选择要导入的文件"
        onChange={(event) => {
          const files = Array.from(event.currentTarget.files ?? []);
          event.currentTarget.value = "";
          if (files.length)
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
