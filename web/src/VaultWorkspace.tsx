import {
  Show,
  createEffect,
  createSignal,
  onCleanup,
  onSettled,
  untrack,
} from "solid-js";
import { GlobalSettings } from "@/components/settings/GlobalSettings";
import { VaultEditor } from "@/components/editor";
import { VaultManager } from "@/lib/vault/manager";
import { VaultConnectionBoundary } from "@/components/vault/VaultConnectionBoundary";
import { VaultConnections } from "@/components/vault/VaultConnections";
import "./components/vault/vault.css";
import { FileTree } from "@/components/file-tree";
import type { FileTreeActions } from "@/components/file-tree/FileTree";
import { supportsLocalDirectories } from "@/lib/vault/file-system-access";
import {
  Button,
  IconButton,
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui";
import { Moon, Sun, Monitor, Check, X } from "@/components/icons";
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
import { isDesktop } from "@/lib/desktop/platform";

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
  const manager = new VaultManager();
  const narrowQuery = window.matchMedia("(max-width: 700px)");
  const [narrow, setNarrow] = createSignal(narrowQuery.matches);
  const [sidebarOpen, setSidebarOpen] = createSignal(!narrowQuery.matches);
  const [focusMode, setFocusMode] = createSignal(false);
  const sidebarVisible = () => sidebarOpen() && !focusMode();
  const drawerOpen = () => narrow() && sidebarVisible();
  let sidebar: HTMLElement | undefined;
  let editorPane: HTMLDivElement | undefined;
  let drawerOpener: HTMLElement | undefined;
  let drawerWasOpen = false;
  function toggleSidebar() {
    drawerOpener =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : undefined;
    const next = !sidebarVisible();
    setFocusMode(false);
    setSidebarOpen(next);
  }
  function toggleFocus() {
    setFocusMode(!focusMode());
  }
  function focusable(element: Element): element is HTMLElement {
    return (
      element instanceof HTMLElement &&
      !element.closest("[inert], [hidden]") &&
      !element.matches(":disabled") &&
      element.getClientRects().length > 0
    );
  }
  function drawerTargets() {
    return Array.from(
      sidebar?.querySelectorAll(
        "button, select, input, a[href], [tabindex='0']",
      ) ?? [],
    ).filter(focusable);
  }
  function restoreDrawerFocus() {
    const target = [
      drawerOpener,
      editorPane?.querySelector("[aria-label='切换文件导航']"),
      editorPane?.querySelector(".cm-content"),
    ].find(
      (element): element is HTMLElement =>
        !!element && element.isConnected && focusable(element),
    );
    target?.focus();
  }
  createEffect(drawerOpen, (open) => {
    if (open === drawerWasOpen) return;
    drawerWasOpen = open;
    queueMicrotask(() => {
      if (drawerOpen()) drawerTargets()[0]?.focus();
      else if (sidebar?.contains(document.activeElement)) restoreDrawerFocus();
    });
  });
  createEffect(sidebarVisible, (visible) => {
    if (!visible && sidebar?.contains(document.activeElement)) {
      queueMicrotask(restoreDrawerFocus);
    }
  });
  onSettled(() => {
    const resize = () => {
      setNarrow(narrowQuery.matches);
      setSidebarOpen(!narrowQuery.matches);
    };
    const keydown = (event: KeyboardEvent) => {
      if (
        !drawerOpen() ||
        !sidebar ||
        !focusable(sidebar) ||
        document.querySelector(
          ".ui-dialog[data-expanded], .ui-menu[data-expanded]",
        ) ||
        event.defaultPrevented ||
        event.isComposing
      )
        return;
      const floating = (event.target as Element | null)?.closest?.(
        ".ui-dialog, .ui-menu",
      );
      if (floating) return;
      if (event.key === "Escape") {
        event.preventDefault();
        setSidebarOpen(false);
      } else if (event.key === "Tab") {
        const targets = drawerTargets();
        const first = targets[0],
          last = targets[targets.length - 1];
        if (!targets.length) return;
        if (
          !sidebar.contains(document.activeElement) ||
          (event.shiftKey
            ? document.activeElement === first
            : document.activeElement === last)
        ) {
          event.preventDefault();
          (event.shiftKey ? last : first).focus();
        }
      }
    };
    const focusin = (event: FocusEvent) => {
      const target = event.target as Element | null;
      if (
        !drawerOpen() ||
        !sidebar ||
        !focusable(sidebar) ||
        document.querySelector(
          ".ui-dialog[data-expanded], .ui-menu[data-expanded]",
        ) ||
        !target ||
        target.closest(".ui-dialog, .ui-menu") ||
        sidebar.contains(target)
      )
        return;
      drawerTargets()[0]?.focus();
    };
    narrowQuery.addEventListener("change", resize);
    document.addEventListener("keydown", keydown);
    document.addEventListener("focusin", focusin);
    return () => {
      narrowQuery.removeEventListener("change", resize);
      document.removeEventListener("keydown", keydown);
      document.removeEventListener("focusin", focusin);
    };
  });
  const [vaults, setVaults] = createSignal(manager.snapshot());
  const unsubscribe = manager.subscribe(setVaults);
  const documents = () => vaults().active;
  const opening = () => vaults().opening;
  const [lifecycleError, setLifecycleError] = createSignal<string | null>(null);
  const openError = () => lifecycleError() ?? vaults().error;
  const [startupRecovery, setStartupRecovery] = createSignal(false);
  createEffect(
    () => ({ ready: !!documents(), failed: !!openError() }),
    ({ ready, failed }) => {
      if (ready) setStartupRecovery(false);
      else if (failed) setStartupRecovery(true);
      // Keep recovery controls mounted during retries so a failed attempt
      // preserves the dialog and its actionable error.
    },
  );
  const [resizing, setResizing] = createSignal(false);
  let treeStatusMount!: HTMLDivElement;
  let editorStatusMount!: HTMLDivElement;
  let dragStart = { x: 0, width: clampSidebarWidth(0) };
  // Solid 的 signal 写入在微任务提交，setter 之后同步读到的仍是旧值；
  // 夹取结果与持久化都用这个同步镜像。
  let appliedWidth = untrack(() =>
    clampSidebarWidth(settings().values["sidebar.width"]),
  );

  let settingsVault: string | null = null;
  createEffect(
    () => vaults().active,
    (vault) => {
      if (settingsVault === (vault?.id ?? null)) return;
      settingsVault = vault?.id ?? null;
      if (narrowQuery.matches) setSidebarOpen(false);
      clearProjectSettings();
      if (vault)
        void attachProjectSettings(() => readProjectSettings(vault.backend));
    },
  );
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
    void manager.initialize();
    let detached = false;
    let detachDesktop: (() => void) | undefined;
    if (isDesktop())
      void import("@/lib/desktop/lifecycle")
        .then(({ attachDesktopLifecycle }) =>
          attachDesktopLifecycle(manager, setLifecycleError),
        )
        .then((detach) => {
          if (detached) detach();
          else detachDesktop = detach;
        })
        .catch((error) => setLifecycleError(String(error)));
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (manager.snapshot().opened.some((v) => v.documents.hasUnsaved())) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    const flush = () => {
      for (const vault of manager.snapshot().opened)
        void vault.documents.saveAll();
    };
    const visibility = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("beforeunload", beforeUnload);
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      detached = true;
      detachDesktop?.();
      window.removeEventListener("beforeunload", beforeUnload);
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", visibility);
    };
  });
  onCleanup(() => {
    unsubscribe();
    clearProjectSettings();
    void manager.close().catch(() => {});
  });

  function SidebarSettings() {
    return (
      <div class="workspace-sidebar-footer">
        <GlobalSettings />
        <DropdownMenu placement="top-end" gutter={6}>
          <DropdownMenuTrigger
            as={IconButton}
            aria-label="主题"
            title="主题"
            size="sm"
          >
            <Show when={theme() === "dark"} fallback={<Moon size={15} />}>
              <Sun size={15} />
            </Show>
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
      </div>
    );
  }
  return (
    <main
      class="workspace"
      data-sidebar-open={sidebarVisible() ? "true" : "false"}
      data-focus={focusMode() ? "true" : "false"}
      onKeyDown={(event) => {
        if (event.defaultPrevented || event.isComposing) return;
        if (
          (event.ctrlKey || event.metaKey) &&
          event.shiftKey &&
          event.key === "Enter"
        ) {
          event.preventDefault();
          toggleFocus();
        } else if ((event.ctrlKey || event.metaKey) && event.key === "\\") {
          event.preventDefault();
          toggleSidebar();
        } else if (event.key === "Escape" && focusMode()) {
          event.preventDefault();
          setFocusMode(false);
        } else if (
          (event.ctrlKey || event.metaKey) &&
          event.key.toLowerCase() === "s"
        ) {
          event.preventDefault();
          void vaults().active?.documents.requestSave();
        }
      }}
    >
      <Show
        when={documents()}
        keyed
        fallback={
          <div class="workspace-opening">
            <Show when={startupRecovery()}>
              <div class="workspace-opening-tools">
                <VaultConnections manager={manager} state={vaults()} />
                <SidebarSettings />
              </div>
            </Show>
            <div class="workspace-opening-message">
              <p role={openError() ? "alert" : "status"} class="text-secondary">
                {opening() || !openError() ? "正在打开文件库…" : openError()}
              </p>
              <Show when={openError()}>
                <Button
                  class="mt-4"
                  onClick={() => void manager.activate(manager.defaultId)}
                >
                  重试
                </Button>
              </Show>
            </div>
          </div>
        }
      >
        {(workspace) => {
          let treeActions: FileTreeActions | undefined;
          const connection = () =>
            vaults().connections.find((item) => item.id === workspace.id);
          const storageDescription = () =>
            connection()?.kind === "opfs"
              ? supportsLocalDirectories()
                ? "笔记保存在此浏览器，也可以打开本机目录直接编辑。"
                : "笔记保存在此浏览器。"
              : connection()?.kind === "remote"
                ? workspace.readOnly
                  ? "当前是只读文件库。浏览文件，开始阅读。"
                  : "已连接远端文件库。打开文件即可协作编辑。"
                : "笔记保存在本机，编辑后会自动保存。";
          return (
            <VaultConnectionBoundary
              documents={workspace.documents}
              recoveryControls={() => (
                <VaultConnections manager={manager} state={vaults()} />
              )}
            >
              {(disabled) => {
                createEffect(disabled, (blocked) => {
                  if (blocked && narrowQuery.matches) setSidebarOpen(false);
                });
                return (
                  <div
                    class="workspace-grid"
                    data-resizing={resizing() ? "true" : "false"}
                    data-blocked={disabled() ? "true" : "false"}
                    style={{
                      "--workspace-sidebar-width": `${sidebarWidth()}px`,
                    }}
                  >
                    <aside
                      class="workspace-sidebar"
                      aria-label="文件导航"
                      role={drawerOpen() ? "dialog" : undefined}
                      aria-modal={drawerOpen() ? "true" : undefined}
                      ref={sidebar}
                    >
                      <div class="workspace-vault-header">
                        <VaultConnections manager={manager} state={vaults()} />
                        <Show when={narrow()}>
                          <IconButton
                            class="workspace-drawer-close"
                            size="sm"
                            aria-label="收起文件导航"
                            title="收起文件导航"
                            onClick={() => setSidebarOpen(false)}
                          >
                            <X size={17} />
                          </IconButton>
                        </Show>
                      </div>
                      <FileTree
                        disabled={disabled()}
                        readOnly={workspace.readOnly}
                        onReady={(actions) => {
                          treeActions = actions;
                        }}
                        backend={workspace.documents.treeBackend}
                        model={workspace.tree}
                        viewState={workspace.treeView}
                        statusMount={treeStatusMount}
                        git={workspace.git}
                        label={workspace.name}
                        rootPath={workspace.root}
                        onOpen={(path) => {
                          const opening = workspace.documents.open(path);
                          if (narrowQuery.matches) setSidebarOpen(false);
                          return opening;
                        }}
                      />
                      <SidebarSettings />
                    </aside>
                    <div
                      class="workspace-divider"
                      role="separator"
                      aria-orientation="vertical"
                      aria-label="调整侧边栏宽度"
                      aria-valuenow={sidebarWidth()}
                      aria-valuemin={
                        SETTINGS_SCHEMA["sidebar.width"].range?.min
                      }
                      aria-valuemax={sidebarLimit()}
                      title="拖动调整侧边栏宽度"
                      tabindex={sidebarVisible() && !narrow() ? 0 : -1}
                      data-dragging={resizing() ? "true" : "false"}
                      onKeyDown={dividerKeyDown}
                      onPointerDown={dividerPointerDown}
                    >
                      <span class="workspace-divider-line" />
                    </div>
                    <div
                      class="workspace-editor-pane"
                      ref={editorPane}
                      inert={drawerOpen()}
                      aria-hidden={drawerOpen() ? "true" : undefined}
                    >
                      <VaultEditor
                        storageDescription={storageDescription()}
                        onNewNote={
                          workspace.readOnly
                            ? undefined
                            : () => treeActions?.createNote()
                        }
                        onBrowseFiles={() => {
                          setFocusMode(false);
                          setSidebarOpen(true);
                          onSettled(() => treeActions?.focus());
                        }}
                        onOpenDirectory={
                          isDesktop() || supportsLocalDirectories()
                            ? () => {
                                void manager
                                  .openDirectory()
                                  // VaultManager reports picker errors and clears
                                  // them when another attempt begins.
                                  .catch(() => {});
                              }
                            : undefined
                        }
                        sidebarOpen={sidebarVisible()}
                        onToggleSidebar={toggleSidebar}
                        focusMode={focusMode()}
                        onToggleFocus={toggleFocus}
                        settings={{
                          previewMode: settings().values["editor.previewMode"],
                          wordWrap: settings().values["editor.wordWrap"],
                          vimMode: settings().values["editor.vimMode"],
                          wordWrapFromProject:
                            settings().source["editor.wordWrap"] === "project",
                        }}
                        onSettingsChange={(patch) => {
                          if (patch.previewMode !== undefined)
                            void setSetting(
                              "editor.previewMode",
                              patch.previewMode,
                            );
                          if (patch.wordWrap !== undefined)
                            void setSetting("editor.wordWrap", patch.wordWrap);
                          if (patch.vimMode !== undefined)
                            void setSetting("editor.vimMode", patch.vimMode);
                        }}
                        authorizeResources={workspace.authorizeResources}
                        documents={workspace.documents}
                        statusMount={editorStatusMount}
                      />
                    </div>
                    <Show when={drawerOpen()}>
                      <button
                        class="workspace-drawer-backdrop"
                        aria-label="关闭文件导航"
                        onClick={() => setSidebarOpen(false)}
                        tabindex={-1}
                      />
                    </Show>
                  </div>
                );
              }}
            </VaultConnectionBoundary>
          );
        }}
      </Show>
      <footer
        class="workspace-statusbar"
        aria-label="工作区状态栏"
        inert={drawerOpen()}
        aria-hidden={drawerOpen() ? "true" : undefined}
      >
        <Show when={openError()}>
          <span
            role="alert"
            class="workspace-status-error"
            title={openError()!}
          >
            {openError()}
          </span>
        </Show>
        <div class="workspace-tree-status" ref={treeStatusMount} />
        <div class="workspace-editor-status" ref={editorStatusMount} />
      </footer>
    </main>
  );
}
