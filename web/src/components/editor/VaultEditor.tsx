import {
  For,
  Loading,
  Show,
  createEffect,
  createSignal,
  lazy,
  onCleanup,
  onSettled,
  untrack,
} from "solid-js";
import {
  Button,
  IconButton,
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui";
import {
  BookOpen,
  Check,
  ChevronDown,
  CodeXml,
  Columns2,
  Ellipsis,
  ListTree,
  LoaderCircle,
  Maximize,
  Minimize,
  PanelLeft,
  Pencil,
  RefreshCw,
  Save,
  X,
} from "@/components/icons";
import type {
  EditorDocuments,
  EditorDocument,
  ExternalChangeStatus,
} from "@/lib/editor/contract";
import type { PreviewModeSetting } from "@/lib/settings/schema";
import type { EditorBuffer } from "./buffer";
import { EditorTabs } from "./EditorTabs";
import { EditorStatus } from "./EditorStatus";

import type { VimMode } from "./vim";
import { SaveConflict } from "./SaveConflict";
import { DocumentPreview, type PreviewActions } from "./DocumentPreview";
import { PreviewSync } from "./preview-sync";
import { CollaborationBar } from "./CollaborationBar";
import { vaultPath } from "@/lib/vault/path";
import {
  createNotistLanguageClient,
  notistLanguageId,
  type LanguageSymbol,
  type VaultWorkspace,
} from "@/lib/language/client";
import type { WorkspaceMapping } from "@codemirror/lsp-client";
import type { EditorView } from "@codemirror/view";
import "./editor.css";
import { languageName } from "./languages";

function externalChangeMessage(status: ExternalChangeStatus) {
  return status.phase === "pending"
    ? "正在同步磁盘中的外部修改，完成后可保存。"
    : `外部修改尚未同步，自动写回已暂停。${status.message}`;
}

const CodeEditor = lazy(() => import("./CodeEditor"));
const previewScrollPositions = new WeakMap<
  EditorDocuments,
  Map<string, number>
>();
// View caches survive workspace switches without extending the documents' lifetime.
const editorBuffers = new WeakMap<EditorDocuments, Map<string, EditorBuffer>>();
interface VaultEditorProps {
  documents: EditorDocuments;
  settings: EditorViewSettings;
  onSettingsChange: (
    patch: Partial<Omit<EditorViewSettings, "wordWrapFromProject">>,
  ) => void;
  authorizeResources?: () => Promise<void>;
  statusMount?: Element;
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  focusMode: boolean;
  onToggleFocus: () => void;
  onNewNote?: () => void;
  onBrowseFiles: () => void;
  onOpenDirectory?: () => void;
  storageDescription: string;
}

export interface EditorViewSettings {
  previewMode: PreviewModeSetting;
  wordWrap: boolean;
  vimMode: boolean;
  wordWrapFromProject: boolean;
}

const displayModes = [
  { mode: "source" as const, label: "源码" },
  { mode: "live" as const, label: "实时渲染" },
  { mode: "split" as const, label: "分栏" },
  { mode: "preview" as const, label: "预览" },
];

function DocumentSymbols(props: {
  workspace: VaultWorkspace;
  document: EditorDocument;
  id: string;
  open: boolean;
  sourceVisible: boolean;
  onClose: () => void;
  onNavigatePreview: (from: number) => void;
}) {
  const [symbols, setSymbols] = createSignal<
    { symbol: LanguageSymbol; depth: number }[]
  >([]);
  const [status, setStatus] = createSignal("正在加载文档大纲…");
  let loadedKey: string | undefined;
  let revision = 0;
  let mapping: WorkspaceMapping | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let requestedSource: string | undefined;
  let requestedUri: string | undefined;
  let focusTarget: EditorView | undefined;
  let closeButton!: HTMLButtonElement;
  let panel: HTMLElement | undefined;
  function release() {
    ++revision;
    clearTimeout(timer);
    mapping?.destroy();
    mapping = undefined;
    requestedSource = undefined;
    requestedUri = undefined;
    focusTarget = undefined;
  }
  function load() {
    if (props.open && panel?.contains(document.activeElement))
      closeButton?.focus();
    release();
    setSymbols([]);
    setStatus("正在加载文档大纲…");
    if (!props.open) return;
    const request = revision;
    const id = props.document.id;
    const source = props.document.content;
    const uri = `file:///vault/${props.document.path}`;
    const client = props.workspace.client;
    timer = setTimeout(() => {
      void client.initializing
        .then(() => {
          if (
            request !== revision ||
            props.document.id !== id ||
            `file:///vault/${props.document.path}` !== uri
          )
            return null;
          client.sync();
          mapping = client.workspaceMapping();
          return client.request<
            { textDocument: { uri: string } },
            LanguageSymbol[] | null
          >("textDocument/documentSymbol", { textDocument: { uri } });
        })
        .then(
          (result) => {
            if (
              request !== revision ||
              props.document.id !== id ||
              `file:///vault/${props.document.path}` !== uri ||
              props.document.content !== source
            )
              return;
            const flatten = (
              items: LanguageSymbol[],
              depth: number,
            ): { symbol: LanguageSymbol; depth: number }[] =>
              items.flatMap((symbol) => [
                { symbol, depth },
                ...flatten(symbol.children ?? [], depth + 1),
              ]);
            requestedSource = source;
            requestedUri = uri;
            setSymbols(flatten(result ?? [], 0));
            setStatus("正文中没有可用的大纲标题");
          },
          () => {
            if (request === revision)
              setStatus("大纲加载失败，请关闭后重新打开重试。");
          },
        );
    }, 120);
  }
  function select(symbol: LanguageSymbol) {
    if (!props.open || props.document.content !== requestedSource) return;
    const uri = `file:///vault/${props.document.path}`;
    if (uri !== requestedUri) return;
    const view = props.workspace.viewFor(uri);
    if (!view || !mapping?.getMapping(uri)) return;
    const from = mapping.mapPosition(uri, symbol.selectionRange.start);
    const to = mapping.mapPosition(uri, symbol.selectionRange.end);
    if (!props.sourceVisible) {
      props.onNavigatePreview(from);
      return;
    }
    view.dispatch({
      selection: { anchor: from, head: to },
      scrollIntoView: true,
    });
    focusTarget = view;
    if (props.sourceVisible) onSettled(focusSelection);
  }
  function focusSelection() {
    const view = focusTarget;
    if (!view || !props.sourceVisible) return;
    focusTarget = undefined;
    if (
      props.open &&
      props.document.content === requestedSource &&
      `file:///vault/${props.document.path}` === requestedUri &&
      props.workspace.viewFor(requestedUri) === view
    )
      view.focus();
  }
  createEffect(
    () => props.sourceVisible,
    (visible) => {
      if (visible) onSettled(focusSelection);
    },
  );
  createEffect(
    () =>
      props.open
        ? JSON.stringify([
            props.document.id,
            props.document.path,
            props.document.reloadVersion,
            props.document.content,
          ])
        : "",
    (key) => {
      if (loadedKey === key) return;
      loadedKey = key;
      untrack(load);
    },
  );
  createEffect(
    () => props.open,
    (open) => {
      if (open) onSettled(() => closeButton?.focus());
    },
  );
  onCleanup(release);
  return (
    <aside
      ref={panel}
      id={props.id}
      class="editor-outline"
      aria-label="文档大纲"
      hidden={!props.open}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          props.onClose();
        }
      }}
    >
      <div class="editor-outline-heading">
        <span>大纲</span>
        <IconButton
          ref={closeButton}
          size="sm"
          aria-label="收起文档大纲"
          onClick={props.onClose}
        >
          <X size={15} />
        </IconButton>
      </div>
      <nav aria-label="文档标题">
        <Show
          when={symbols().length}
          fallback={
            <p class="editor-outline-status" role="status">
              {status()}
            </p>
          }
        >
          <For each={symbols()}>
            {({ symbol, depth }) => (
              <button
                type="button"
                class="editor-outline-item"
                onClick={() => select(symbol)}
                title={symbol.detail}
                style={{ "--outline-depth": depth }}
              >
                {symbol.name}
              </button>
            )}
          </For>
        </Show>
      </nav>
    </aside>
  );
}

export function VaultEditor(props: VaultEditorProps) {
  const previewSync = new PreviewSync();
  // Best-effort Notist language service; null when the channel is unavailable.
  let languageWorkspace: VaultWorkspace | undefined;
  const language = createNotistLanguageClient(props.documents, async (path) => {
    const uri = `file:///vault/${path}`;
    const mounted = languageWorkspace?.viewFor(uri);
    if (mounted) return mounted;
    if (!(await props.documents.open(vaultPath(path)))) return null;
    return (await languageWorkspace?.waitForView(uri, 2000)) ?? null;
  });
  languageWorkspace = language?.workspace;
  const [outlineOpen, setOutlineOpen] = createSignal(false);
  let outlineTrigger: HTMLButtonElement | undefined;
  const [scrollSync, setScrollSync] = createSignal(true);
  const [state, setState] = createSignal(props.documents.snapshot());
  const unsubscribe = props.documents.subscribe(setState);
  const [cursor, setCursor] = createSignal({ line: 1, column: 1 });
  const [vimMode, setVimMode] = createSignal<VimMode | null>(null);
  const [closingTabs, setClosingTabs] = createSignal(false);
  let previewActions: PreviewActions | undefined;
  const mode = () => props.settings.previewMode;
  const previewMedia = window.matchMedia("(max-width: 700px)");
  const [narrowScreen, setNarrowScreen] = createSignal(previewMedia.matches);
  const onPreviewResize = () => setNarrowScreen(previewMedia.matches);
  const [reveal, setReveal] = createSignal<{
    from: number;
    to: number;
    requestId: string;
  }>();
  const [fragment, setFragment] = createSignal<{ id: string; value: string }>();
  const views =
    previewScrollPositions.get(props.documents) ?? new Map<string, number>();
  previewScrollPositions.set(props.documents, views);
  const wrap = () => props.settings.wordWrap;
  /** 项目级文件提供时界面不改写，避免“点了没反应”。 */
  const wrapFromProject = () => props.settings.wordWrapFromProject;
  const buffers =
    editorBuffers.get(props.documents) ?? new Map<string, EditorBuffer>();
  editorBuffers.set(props.documents, buffers);
  const panelId = `editor-${crypto.randomUUID()}`;
  const active = () =>
    state().documents.find((document) => document.id === state().activeId);
  const canRender = () =>
    !!props.documents.previews &&
    !!active()?.canPreview &&
    /\.(not|md|markdown)$/i.test(active()?.path ?? "");
  const canLiveRender = () =>
    !!active()?.canPreview &&
    /\.(not|md|markdown|nmd|notmd)$/i.test(active()?.path ?? "");
  const displayMode = (): PreviewModeSetting => {
    const selected = mode();
    if (selected === "live") return canLiveRender() ? "live" : "source";
    if (!canRender()) return "source";
    return selected === "split" && narrowScreen() ? "preview" : selected;
  };
  createEffect(
    () => displayMode() === "split" && scrollSync(),
    (enabled) => previewSync.setEnabled(enabled),
  );
  function chooseMode(value: PreviewModeSetting) {
    props.onSettingsChange({ previewMode: value });
  }
  createEffect(
    () => state().activeId,
    () => {
      setReveal(undefined);
      setVimMode(null);
    },
  );
  const tabId = (id: string) => `${panelId}-${id}`;
  createEffect(
    () => state().documents.map((document) => document.id),
    (ids) => {
      for (const id of buffers.keys())
        if (!ids.includes(id)) buffers.delete(id);
      for (const id of views.keys()) if (!ids.includes(id)) views.delete(id);
    },
  );
  onSettled(() => {
    previewMedia.addEventListener("change", onPreviewResize);
    onPreviewResize();
  });
  onCleanup(() => {
    previewSync.dispose();
    language?.dispose();
    previewMedia.removeEventListener("change", onPreviewResize);
    unsubscribe();
  });
  function canCloseTabs(ids: string[]) {
    return (
      !closingTabs() &&
      !state().conflictPrompt &&
      ids.length > 0 &&
      ids.every((id) => {
        const file = state().documents.find((document) => document.id === id);
        return file && !file.locked && !file.saving;
      })
    );
  }
  async function closeTabs(ids: string[]) {
    if (!canCloseTabs(ids)) return;
    setClosingTabs(true);
    try {
      // Snapshot the targets and close in order; a failed save or conflict
      // stops the batch so later tabs and their drafts remain open.
      for (const id of ids) {
        if (!props.documents.has(id)) continue;
        if (!(await props.documents.requestCloseDocument(id))) {
          props.documents.activate(id);
          break;
        }
      }
    } finally {
      setClosingTabs(false);
    }
  }
  const hasOutline = () =>
    !!language && !!notistLanguageId(active()?.path ?? "");
  const saveDisabled = () =>
    (!active()?.dirty &&
      !active()?.pending &&
      !active()?.core?.recoveryError) ||
    !!active()?.saving ||
    !!active()?.externalChange ||
    !!active()?.locked ||
    !!active()?.readOnlyReason;
  function closeOutline() {
    setOutlineOpen(false);
    onSettled(() => outlineTrigger?.focus());
  }
  function modeIcon() {
    return displayMode() === "live" ? (
      <Pencil size={13} />
    ) : displayMode() === "source" ? (
      <CodeXml size={13} />
    ) : displayMode() === "split" ? (
      <Columns2 size={13} />
    ) : (
      <BookOpen size={13} />
    );
  }
  function modeItems() {
    return (
      <DropdownMenu.RadioGroup
        value={displayMode()}
        onChange={(value) => chooseMode(value as PreviewModeSetting)}
        aria-label="编辑器视图"
      >
        <For
          each={displayModes.filter((item) =>
            item.mode === "live"
              ? canLiveRender()
              : item.mode === "source" || canRender(),
          )}
        >
          {(item) => (
            <DropdownMenu.RadioItem
              closeOnSelect
              value={item.mode}
              disabled={item.mode === "split" && narrowScreen()}
              aria-label={item.label}
              class="ui-menu-item editor-mode-item"
            >
              <span>{item.label}</span>
              <Show when={item.mode === "split" && narrowScreen()}>
                <span class="editor-menu-hint">需更宽窗口</span>
              </Show>
              <Show when={displayMode() === item.mode}>
                <Check size={14} />
              </Show>
            </DropdownMenu.RadioItem>
          )}
        </For>
      </DropdownMenu.RadioGroup>
    );
  }
  function documentMenu() {
    return (
      <DropdownMenu placement="bottom-end" gutter={6}>
        <DropdownMenuTrigger
          as={IconButton}
          size="sm"
          aria-label="文档选项"
          title="文档选项"
        >
          <Ellipsis size={17} />
        </DropdownMenuTrigger>
        <DropdownMenuContent aria-label="文档选项">
          <Show when={narrowScreen()}>
            {modeItems()}
            <DropdownMenuSeparator />
          </Show>
          <Show
            when={
              narrowScreen() &&
              mode() === "split" &&
              displayMode() === "preview"
            }
          >
            <p class="editor-menu-note">
              窗口较窄，当前显示预览；加宽后恢复分栏。
            </p>
          </Show>
          <DropdownMenuItem
            disabled={!active() || saveDisabled()}
            aria-label="保存"
            onSelect={() => void props.documents.requestSave()}
          >
            <Save size={14} />
            <span>保存</span>
            <kbd>Ctrl / ⌘ S</kbd>
          </DropdownMenuItem>
          <Show when={displayMode() === "preview" || displayMode() === "split"}>
            <DropdownMenuItem onSelect={() => previewActions?.refresh()}>
              <RefreshCw size={14} />
              <span>刷新预览</span>
            </DropdownMenuItem>
            <Show when={props.authorizeResources}>
              <DropdownMenuItem onSelect={() => previewActions?.authorize?.()}>
                授权依赖目录
              </DropdownMenuItem>
            </Show>
          </Show>
          <Show
            when={
              active() &&
              displayMode() !== "live" &&
              displayMode() !== "preview"
            }
          >
            <DropdownMenu.CheckboxItem
              closeOnSelect
              class="ui-menu-item"
              checked={wrap()}
              disabled={wrapFromProject() || !!active()?.readOnlyReason}
              onChange={(checked) =>
                props.onSettingsChange({ wordWrap: checked })
              }
              title={
                wrapFromProject()
                  ? "由 .celestite/settings.json 提供，编辑该文件后生效"
                  : undefined
              }
            >
              <span>自动换行</span>
              <Show when={wrap()}>
                <Check size={14} />
              </Show>
            </DropdownMenu.CheckboxItem>
          </Show>
          <Show when={displayMode() === "split"}>
            <DropdownMenu.CheckboxItem
              closeOnSelect
              class="ui-menu-item"
              checked={scrollSync()}
              onChange={setScrollSync}
              title="按对应内容同步两侧滚动"
            >
              <span>滚动同步</span>
              <Show when={scrollSync()}>
                <Check size={14} />
              </Show>
            </DropdownMenu.CheckboxItem>
          </Show>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={props.onToggleFocus}>
            {props.focusMode ? <Minimize size={14} /> : <Maximize size={14} />}
            <span>{props.focusMode ? "退出专注写作" : "专注写作"}</span>
          </DropdownMenuItem>
          <Show when={hasOutline()}>
            <DropdownMenuItem
              disabled={props.focusMode}
              title={props.focusMode ? "退出专注写作后可展开大纲" : undefined}
              onSelect={() => setOutlineOpen((open) => !open)}
            >
              <ListTree size={14} />
              <span>{outlineOpen() ? "收起文档大纲" : "打开文档大纲"}</span>
            </DropdownMenuItem>
          </Show>
          <Show when={active()}>
            {(file) => (
              <>
                <DropdownMenuSeparator />
                <div class="editor-menu-info" aria-label="文档信息">
                  <span>{file().path}</span>
                  <span>
                    {languageName(file().path)} · UTF-8
                    {file().bom ? " BOM" : ""} ·{" "}
                    {file().lineEnding === "\r\n"
                      ? "CRLF"
                      : file().lineEnding === "\r"
                        ? "CR"
                        : "LF"}
                  </span>
                </div>
              </>
            )}
          </Show>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }
  return (
    <section
      aria-label="文件编辑器"
      class="vault-editor"
      onKeyDown={(event) => {
        if (
          !event.defaultPrevented &&
          (event.ctrlKey || event.metaKey) &&
          event.key.toLowerCase() === "s"
        ) {
          event.preventDefault();
          void props.documents.requestSave();
        }
      }}
    >
      <div class="flex min-h-0 min-w-0 flex-1 flex-col">
        <Show when={state().openError}>
          <p
            role="alert"
            class="border-b border-solid border-border px-4 py-2 text-ui-sm text-danger"
          >
            {state().openError}
          </p>
        </Show>
        <header class="editor-tabbar">
          <IconButton
            size="sm"
            class="editor-sidebar-toggle"
            aria-label="切换文件导航"
            aria-expanded={props.sidebarOpen ? "true" : "false"}
            title="切换文件导航 · Ctrl / ⌘ \\"
            onClick={props.onToggleSidebar}
          >
            <PanelLeft size={17} />
          </IconButton>
          <EditorTabs
            state={state()}
            panelId={panelId}
            canClose={canCloseTabs}
            onClose={(ids) => void closeTabs(ids)}
            onActivate={(id) => props.documents.activate(id)}
          />
          <div class="editor-tabbar-actions">
            <Show when={state().collaboration}>
              {(members) => (
                <CollaborationBar
                  state={members()}
                  documentId={state().activeId}
                />
              )}
            </Show>
            <IconButton
              size="sm"
              class="editor-focus-toggle"
              aria-label={props.focusMode ? "退出专注写作" : "专注写作"}
              aria-pressed={props.focusMode ? "true" : "false"}
              onClick={props.onToggleFocus}
              title="专注写作 · Ctrl / ⌘ Shift Enter"
            >
              {props.focusMode ? (
                <Minimize size={16} />
              ) : (
                <Maximize size={16} />
              )}
            </IconButton>
            <IconButton
              ref={outlineTrigger}
              size="sm"
              aria-label="文档大纲"
              aria-controls={`${panelId}-outline`}
              aria-expanded={
                outlineOpen() && !props.focusMode && hasOutline()
                  ? "true"
                  : "false"
              }
              disabled={!hasOutline() || props.focusMode}
              onClick={() => setOutlineOpen((open) => !open)}
              title="文档大纲"
            >
              <ListTree size={17} />
            </IconButton>
            {documentMenu()}
          </div>
        </header>
        <Show
          when={!state().loadingPath}
          fallback={
            <div class="editor-loading" role="status" aria-live="polite">
              <LoaderCircle
                size={22}
                class="editor-loading-icon"
                aria-hidden="true"
              />
              <span class="text-ui-sm">正在打开 {state().loadingPath}…</span>
            </div>
          }
        >
          <Show
            when={active()?.id}
            keyed
            fallback={
              <div class="editor-empty">
                <h2 class="text-ui-heading font-medium">
                  {props.onNewNote ? "开始一份笔记" : "打开一份文件"}
                </h2>
                <p class="mt-2 text-ui-sm text-secondary">
                  {props.storageDescription}
                </p>
                <div class="editor-empty-actions">
                  <Show when={props.onNewNote}>
                    <Button
                      variant="primary"
                      onClick={() => props.onNewNote?.()}
                    >
                      创建笔记
                    </Button>
                  </Show>
                  <Button variant="ghost" onClick={props.onBrowseFiles}>
                    浏览文件
                  </Button>
                  <Show when={props.onOpenDirectory}>
                    <Button
                      variant="ghost"
                      onClick={() => props.onOpenDirectory?.()}
                    >
                      打开本机目录
                    </Button>
                  </Show>
                </div>
              </div>
            }
          >
            {(id) => (
              <>
                <header class="editor-toolbar">
                  <span class="editor-breadcrumbs" title={active()?.path}>
                    <For each={(active()?.path ?? "").split("/").slice(0, -1)}>
                      {(part, index) => (
                        <>
                          <Show when={index() > 0}>
                            <span aria-hidden="true">/</span>
                          </Show>
                          <span>{part}</span>
                        </>
                      )}
                    </For>
                    <Show when={!(active()?.path ?? "").includes("/")}>
                      <span>笔记库</span>
                    </Show>
                  </span>
                  <div class="editor-document-actions">
                    <Show when={props.focusMode}>
                      <Button
                        class="editor-focus-exit"
                        size="sm"
                        variant="ghost"
                        onClick={props.onToggleFocus}
                      >
                        退出专注 <kbd>Esc</kbd>
                      </Button>
                    </Show>
                    <Show when={canRender() || canLiveRender()}>
                      <DropdownMenu placement="bottom-end" gutter={6}>
                        <DropdownMenuTrigger
                          as={Button}
                          class="editor-mode-trigger"
                          size="sm"
                          variant="ghost"
                          aria-label="编辑器视图"
                          title={
                            mode() !== displayMode()
                              ? `偏好为${displayModes.find((item) => item.mode === mode())?.label}，当前显示${displayModes.find((item) => item.mode === displayMode())?.label}`
                              : "切换编辑器视图"
                          }
                        >
                          {modeIcon()}
                          <span>
                            {
                              displayModes.find(
                                (item) => item.mode === displayMode(),
                              )?.label
                            }
                          </span>
                          <ChevronDown size={11} />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent aria-label="编辑器视图">
                          {modeItems()}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </Show>
                  </div>
                </header>
                <Show when={active()?.externalChange}>
                  {(status) => (
                    <div
                      role="status"
                      class="flex shrink-0 items-center gap-2 border-b border-solid border-border px-4 py-2 text-ui-sm text-secondary"
                    >
                      <span class="flex-1">
                        {externalChangeMessage(status())}
                      </span>
                      <Show
                        when={
                          status().phase === "failed" &&
                          props.documents.retryObservation
                        }
                      >
                        <Button
                          size="sm"
                          disabled={active()?.locked}
                          onClick={() =>
                            void props.documents.retryObservation?.(id)
                          }
                        >
                          重试同步
                        </Button>
                      </Show>
                    </div>
                  )}
                </Show>
                <Show when={active()?.error && !active()?.externalChange}>
                  <div
                    role="alert"
                    class="flex shrink-0 items-center gap-2 border-b border-solid border-border px-4 py-2 text-ui-sm text-danger"
                  >
                    <span class="flex-1">
                      {active()?.conflict
                        ? "磁盘文件已变化，本地编辑仍保留。"
                        : `保存失败，修改仍保留在编辑器中。${active()?.error}`}
                    </span>
                    <Button
                      size="sm"
                      disabled={active()?.saving || active()?.locked}
                      onClick={() => void props.documents.requestSave(id)}
                    >
                      {active()?.conflict ? "处理冲突" : "重试保存"}
                    </Button>
                  </div>
                </Show>
                <Show when={active()?.canPreview && active()?.readOnlyReason}>
                  <p class="border-b border-solid border-border px-4 py-2 text-ui-sm text-secondary">
                    {active()?.readOnlyReason}
                  </p>
                </Show>
                <div
                  id={panelId}
                  role="tabpanel"
                  aria-labelledby={tabId(id)}
                  class="editor-document-body"
                >
                  <Show
                    when={active()?.canPreview}
                    fallback={
                      <p class="m-auto max-w-md p-6 text-secondary">
                        {active()?.readOnlyReason}
                      </p>
                    }
                  >
                    <div class="editor-layout" data-mode={displayMode()}>
                      <div class="editor-source-pane">
                        <Loading
                          fallback={
                            <p role="status" class="p-4 text-secondary">
                              正在加载编辑器…
                            </p>
                          }
                        >
                          <Show when={`${id}:${active()?.reloadVersion}`} keyed>
                            {(_viewKey) => (
                              <CodeEditor
                                activation={state().activation}
                                previewSync={previewSync}
                                lspClient={language?.client}
                                reveal={reveal()}
                                document={active()!}
                                cached={buffers.get(id)}
                                wrap={displayMode() === "live" || wrap()}
                                live={displayMode() === "live"}
                                vim={props.settings.vimMode}
                                onVimMode={setVimMode}
                                onView={(
                                  viewId,
                                  documentId,
                                  focused,
                                  selection,
                                ) => {
                                  void props.documents
                                    .setView?.(
                                      viewId,
                                      documentId,
                                      focused,
                                      selection,
                                    )
                                    .catch(() => {});
                                }}
                                onComposition={(active) =>
                                  props.documents.composition?.(id, active)
                                }
                                onTransaction={(transaction) =>
                                  props.documents.edit(id, transaction)
                                }
                                onUndo={(context, redo) => {
                                  void props.documents.undo(id, context, redo);
                                }}
                                onSave={() => {
                                  void props.documents.requestSave(id);
                                }}
                                onClose={() => void closeTabs([id])}
                                onCursor={(line, column) =>
                                  setCursor({ line, column })
                                }
                                onCache={(buffer) => {
                                  if (props.documents.has(id))
                                    buffers.set(id, buffer);
                                }}
                              />
                            )}
                          </Show>
                        </Loading>
                      </div>
                      <Show
                        when={
                          canRender() &&
                          (displayMode() === "split" ||
                            displayMode() === "preview")
                        }
                      >
                        <DocumentPreview
                          statusMount={props.statusMount}
                          revealOnClick={displayMode() === "split"}
                          onReady={(actions) => {
                            previewActions = actions;
                          }}
                          sync={previewSync}
                          document={active()!}
                          documents={props.documents}
                          authorizeResources={props.authorizeResources}
                          scrollTop={views.get(id) ?? 0}
                          fragment={
                            fragment()?.id === id
                              ? fragment()?.value
                              : undefined
                          }
                          onScroll={(scrollTop) => views.set(id, scrollTop)}
                          onDiagnostic={async (diagnostic) => {
                            if (
                              !(await props.documents.open(
                                vaultPath(diagnostic.path),
                              ))
                            )
                              throw new Error(`无法打开 ${diagnostic.path}`);
                            const snapshot = props.documents.snapshot();
                            const target = snapshot.documents.find(
                              (document) => document.id === snapshot.activeId,
                            );
                            if (
                              !target ||
                              target.pending ||
                              (diagnostic.source !== null &&
                                target.content !== diagnostic.source)
                            )
                              throw new Error(
                                "诊断来源已变化，请重新生成预览。",
                              );
                            chooseMode("source");
                            onSettled(() => {
                              setReveal({
                                from: diagnostic.from,
                                to: diagnostic.to,
                                requestId: crypto.randomUUID(),
                              });
                            });
                          }}
                          onReveal={(from, to, keepSplit) => {
                            if (!keepSplit || displayMode() !== "split")
                              chooseMode("source");
                            setReveal({
                              from,
                              to,
                              requestId: crypto.randomUUID(),
                            });
                          }}
                          onNavigate={async (path, anchor) => {
                            if (!(await props.documents.open(vaultPath(path))))
                              return false;
                            const targetId =
                              props.documents.snapshot().activeId;
                            if (targetId) {
                              setFragment(
                                anchor === null
                                  ? undefined
                                  : { id: targetId, value: anchor },
                              );
                            }
                            return true;
                          }}
                        />
                      </Show>
                    </div>
                  </Show>
                  <Show when={hasOutline()}>
                    <DocumentSymbols
                      id={`${panelId}-outline`}
                      workspace={language!.workspace}
                      document={active()!}
                      open={outlineOpen() && !props.focusMode}
                      sourceVisible={displayMode() !== "preview"}
                      onClose={closeOutline}
                      onNavigatePreview={(from) => {
                        previewSync.revealPreview(from);
                        if (narrowScreen()) closeOutline();
                      }}
                    />
                  </Show>
                </div>
                <EditorStatus
                  document={active()!}
                  reading={displayMode() === "preview"}
                  mount={props.statusMount}
                  cursor={cursor()}
                  vimMode={
                    props.settings.vimMode &&
                    !active()?.readOnlyReason &&
                    displayMode() !== "preview"
                      ? (vimMode() ?? "NORMAL")
                      : null
                  }
                />
              </>
            )}
          </Show>
        </Show>
        <Show
          when={!state().connection || state().connection?.status === "online"}
        >
          <SaveConflict documents={props.documents} state={state()} />
        </Show>
      </div>
    </section>
  );
}
