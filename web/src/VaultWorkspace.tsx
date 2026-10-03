import {
  Show,
  createEffect,
  createSignal,
  onCleanup,
  onSettled,
} from "solid-js";
import { GlobalSettings } from "@/components/settings/GlobalSettings";
import { VaultEditor } from "@/components/editor";
import { VaultDocuments } from "@/lib/editor/documents";
import { FileTree } from "@/components/file-tree";
import {
  Button,
  IconButton,
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui";
import { Moon, Sun, Monitor, Check } from "@/components/icons";
import { openOpfsVault } from "@/lib/vault";
import { theme, setTheme } from "@/lib/theme";
import { SETTINGS_SCHEMA } from "@/lib/settings/schema";
import {
  attachProjectSettings,
  clearProjectSettings,
  setSetting,
  settings,
} from "@/lib/settings";
import { readProjectSettings } from "@/lib/settings/project";
import "./workspace.css";

/** 侧边栏宽度与 Zed 的左侧 dock 一样可拖动；取值范围由设置 schema 决定。 */
const SIDEBAR_STEP = 16;

function sidebarLimit() {
  // schema 的 min/max 之外再受视口宽度约束，编辑器始终保留可用空间。
  return Math.max(
    SETTINGS_SCHEMA["sidebar.width"].default,
    Math.min(
      SETTINGS_SCHEMA["sidebar.width"].range?.max ?? 560,
      Math.round(window.innerWidth * 0.6),
    ),
  );
}
function clampSidebarWidth(value: number) {
  const range = SETTINGS_SCHEMA["sidebar.width"].range ?? {
    min: 200,
    max: 560,
  };
  if (!Number.isFinite(value)) return SETTINGS_SCHEMA["sidebar.width"].default;
  return Math.round(Math.min(sidebarLimit(), Math.max(range.min, value)));
}

export default function VaultWorkspace() {
  const [documents, setDocuments] = createSignal<VaultDocuments | null>(null);
  const [opening, setOpening] = createSignal(true);
  const [openError, setOpenError] = createSignal<string | null>(null);
  const [resizing, setResizing] = createSignal(false);
  let treeStatusMount!: HTMLDivElement;
  let editorStatusMount!: HTMLDivElement;
  let currentDocuments: VaultDocuments | null = null;
  let disposed = false;
  let starting = false;
  let dragStart = { x: 0, width: clampSidebarWidth(0) };
  // Solid 的 signal 写入在微任务提交，setter 之后同步读到的仍是旧值；
  // 夹取结果与持久化都用这个同步镜像。
  let appliedWidth = clampSidebarWidth(settings().values["sidebar.width"]);

  async function start() {
    if (starting || disposed) return;
    starting = true;
    setOpening(true);
    setOpenError(null);
    try {
      const opened = await openOpfsVault();
      if (disposed) {
        await opened.close();
        return;
      }
      currentDocuments = new VaultDocuments(opened);
      setDocuments(currentDocuments);
      // vault 打开后载入项目级覆盖；文件缺失或读失败都视为没有覆盖。
      void attachProjectSettings(() => readProjectSettings(opened));
    } catch {
      if (!disposed)
        setOpenError(
          "无法打开文件库。请检查浏览器是否允许保存站点数据，然后重试。",
        );
    } finally {
      starting = false;
      if (!disposed) setOpening(false);
    }
  }
  /** 宽度来自设置层，因此项目级文件也能覆盖它。 */
  const sidebarWidth = () =>
    clampSidebarWidth(settings().values["sidebar.width"]);
  createEffect(sidebarWidth, (width) => {
    appliedWidth = width;
  });
  /** 拖动中只改内存态，不落盘。 */
  function previewSidebarWidth(width: number) {
    const next = clampSidebarWidth(width);
    appliedWidth = next;
    void setSetting("sidebar.width", next, { persist: false });
  }
  /** 松手、键盘、窗口变化时一次性写入设置文件。 */
  function commitSidebarWidth(width = appliedWidth) {
    const next = clampSidebarWidth(width);
    appliedWidth = next;
    void setSetting("sidebar.width", next);
  }
  function dividerKeyDown(event: KeyboardEvent) {
    const targets: Record<string, number> = {
      ArrowLeft: appliedWidth - SIDEBAR_STEP,
      ArrowRight: appliedWidth + SIDEBAR_STEP,
      Home: SETTINGS_SCHEMA["sidebar.width"].range?.min ?? sidebarLimit(),
      End: sidebarLimit(),
    };
    const target = targets[event.key];
    if (target === undefined) return;
    event.preventDefault();
    commitSidebarWidth(target);
  }
  function dividerPointerDown(
    event: PointerEvent & { currentTarget: HTMLElement },
  ) {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.preventDefault();
    const divider = event.currentTarget;
    dragStart = { x: event.clientX, width: appliedWidth };
    const move = (moveEvent: PointerEvent) =>
      previewSidebarWidth(dragStart.width + moveEvent.clientX - dragStart.x);
    const stop = () => {
      setResizing(false);
      divider.removeEventListener("pointermove", move);
      divider.removeEventListener("pointerup", stop);
      divider.removeEventListener("pointercancel", stop);
      // 拖动过程中只改内存态，松手时一次性落盘。
      commitSidebarWidth();
    };
    divider.setPointerCapture(event.pointerId);
    setResizing(true);
    divider.addEventListener("pointermove", move);
    divider.addEventListener("pointerup", stop);
    divider.addEventListener("pointercancel", stop);
  }
  // onSettled 的返回值即清理函数，效果内部不允许调用 onCleanup。
  onSettled(() => {
    const onWindowResize = () => {
      // 视口变窄时夹取；值没变就不写文件。
      const next = clampSidebarWidth(appliedWidth);
      if (next !== appliedWidth || next !== sidebarWidth())
        commitSidebarWidth(next);
    };
    window.addEventListener("resize", onWindowResize);
    return () => window.removeEventListener("resize", onWindowResize);
  });
  onSettled(() => {
    void start();
  });
  onCleanup(() => {
    disposed = true;
    clearProjectSettings();
    void currentDocuments?.close();
  });

  return (
    <main
      class="workspace flex h-dvh min-h-0 flex-col"
      onKeyDown={(event) => {
        if (
          !event.defaultPrevented &&
          (event.ctrlKey || event.metaKey) &&
          event.key.toLowerCase() === "s"
        ) {
          event.preventDefault();
          void currentDocuments?.save();
        }
      }}
    >
      <Show
        when={documents()}
        keyed
        fallback={
          <div class="m-auto max-w-md p-8 text-center">
            <p role={openError() ? "alert" : "status"} class="text-secondary">
              {opening() ? "正在打开文件库…" : openError()}
            </p>
            <Show when={openError()}>
              <Button class="mt-4" onClick={() => void start()}>
                重试
              </Button>
            </Show>
          </div>
        }
      >
        {(workspace) => (
          <div
            class="workspace-grid grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)] sm:grid-cols-[var(--workspace-sidebar-width)_5px_minmax(0,1fr)]"
            data-resizing={resizing() ? "true" : "false"}
            style={{
              "--workspace-sidebar-width": `${sidebarWidth()}px`,
            }}
          >
            <div class="workspace-sidebar flex min-h-0 flex-col">
              <FileTree
                backend={workspace.treeBackend}
                statusMount={treeStatusMount}
                label="我的 Vault"
                onOpen={(path) => void workspace.open(path)}
              />
            </div>
            <div
              class="workspace-divider"
              role="separator"
              aria-orientation="vertical"
              aria-label="调整侧边栏宽度"
              aria-valuenow={sidebarWidth()}
              aria-valuemin={SETTINGS_SCHEMA["sidebar.width"].range?.min}
              aria-valuemax={sidebarLimit()}
              title="拖动调整侧边栏宽度"
              tabindex={0}
              data-dragging={resizing() ? "true" : "false"}
              onKeyDown={dividerKeyDown}
              onPointerDown={dividerPointerDown}
            >
              <span class="workspace-divider-line" />
            </div>
            <VaultEditor
              documents={workspace}
              statusMount={editorStatusMount}
            />
          </div>
        )}
      </Show>
      <footer class="workspace-statusbar" aria-label="工作区状态栏">
        <div class="workspace-tree-status" ref={treeStatusMount} />
        <div class="workspace-editor-status" ref={editorStatusMount} />
        <Show when={import.meta.env.DEV}>
          <a
            href="/ui"
            class="hidden px-2 text-ui-sm text-secondary no-underline hover:text-foreground sm:inline"
          >
            组件预览
          </a>
        </Show>
        <DropdownMenu placement="top-end" gutter={6}>
          <DropdownMenuTrigger
            as={IconButton}
            aria-label="主题"
            title="主题"
            size="sm"
          >
            <Monitor size={15} />
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem onSelect={() => setTheme("system")}>
              <Monitor size={15} />
              跟随系统
              <Show when={theme() === "system"}>
                <Check size={14} class="ml-auto" />
              </Show>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setTheme("light")}>
              <Sun size={15} />
              浅色
              <Show when={theme() === "light"}>
                <Check size={14} class="ml-auto" />
              </Show>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setTheme("dark")}>
              <Moon size={15} />
              深色
              <Show when={theme() === "dark"}>
                <Check size={14} class="ml-auto" />
              </Show>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <GlobalSettings />
      </footer>
    </main>
  );
}
