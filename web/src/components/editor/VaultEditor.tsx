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
import { Button, IconButton } from "@/components/ui";
import { StatusSlot } from "@/components/ui/status-slot";
import {
  ChevronLeft,
  FileText,
  LoaderCircle,
  Save,
  X,
} from "@/components/icons";
import type { EditorDocuments } from "@/lib/editor/contract";
import { setSetting, settings } from "@/lib/settings";
import type { EditorBuffer } from "./CodeEditor";
import { languageName } from "./languages";
import { SaveConflict } from "./SaveConflict";
import { DocumentPreview } from "./DocumentPreview";
import { PreviewSync } from "./preview-sync";
import { vaultPath } from "@/lib/vault/path";
import "./editor.css";

const CodeEditor = lazy(() => import("./CodeEditor"));
type PreviewMode = "source" | "split" | "preview";
const previewViews = new WeakMap<
  EditorDocuments,
  Map<string, { mode: PreviewMode; scrollTop: number }>
>();
interface VaultEditorProps {
  documents: EditorDocuments;
  buffers?: Map<string, EditorBuffer>;
  statusMount?: Element;
}

export function VaultEditor(props: VaultEditorProps) {
  const previewSync = new PreviewSync();
  const [scrollSync, setScrollSync] = createSignal(true);
  const [state, setState] = createSignal(props.documents.snapshot());
  const unsubscribe = props.documents.subscribe(setState);
  const [mobileVisible, setMobileVisible] = createSignal(false);
  const [cursor, setCursor] = createSignal({ line: 1, column: 1 });
  const [mode, setMode] = createSignal<PreviewMode>("source");
  const previewMedia = window.matchMedia("(max-width: 639px)");
  const [narrowScreen, setNarrowScreen] = createSignal(previewMedia.matches);
  const onPreviewResize = () => setNarrowScreen(previewMedia.matches);
  const [reveal, setReveal] = createSignal<{
    from: number;
    to: number;
    requestId: string;
  }>();
  const [fragment, setFragment] = createSignal<{ id: string; value: string }>();
  const views =
    previewViews.get(props.documents) ??
    new Map<string, { mode: PreviewMode; scrollTop: number }>();
  previewViews.set(props.documents, views);
  const wrap = () => settings().values["editor.wordWrap"];
  /** 项目级文件提供时界面不改写，避免“点了没反应”。 */
  const wrapFromProject = () =>
    settings().source["editor.wordWrap"] === "project";
  const buffers = props.buffers ?? new Map<string, EditorBuffer>();
  const panelId = `editor-${crypto.randomUUID()}`;
  const active = () =>
    state().documents.find((document) => document.id === state().activeId);
  const canRender = () =>
    !!props.documents.previews &&
    !!active()?.canPreview &&
    /\.(not|md|markdown)$/i.test(active()?.path ?? "");
  const displayMode = () =>
    !canRender()
      ? "source"
      : mode() === "split" && narrowScreen()
        ? "preview"
        : mode();
  createEffect(
    () => displayMode() === "split" && scrollSync(),
    (enabled) => previewSync.setEnabled(enabled),
  );
  function chooseMode(value: PreviewMode) {
    const id = state().activeId;
    if (id)
      views.set(id, { mode: value, scrollTop: views.get(id)?.scrollTop ?? 0 });
    setMode(value);
  }
  createEffect(
    () => state().activeId,
    (id) => {
      setMode(id ? (views.get(id)?.mode ?? "source") : "source");
      setReveal(undefined);
    },
  );
  const tabId = (id: string) => `${panelId}-${id}`;
  const status = () => {
    const file = active();
    return file?.saving
      ? "正在保存…"
      : file?.locked
        ? "正在处理文件…"
        : file?.error
          ? "保存失败"
          : file?.dirty || file?.pending
            ? "未保存"
            : file?.readOnlyReason
              ? file.canPreview
                ? "只读"
                : "无法编辑"
              : "已保存";
  };
  createEffect(
    () => state().activation,
    () => {
      setMobileVisible(true);
    },
  );
  createEffect(
    () => state().documents.map((document) => document.id),
    (ids) => {
      for (const id of buffers.keys())
        if (!ids.includes(id)) buffers.delete(id);
      for (const id of views.keys()) if (!ids.includes(id)) views.delete(id);
    },
  );
  const beforeUnload = (event: BeforeUnloadEvent) => {
    if (props.documents.hasUnsaved()) {
      event.preventDefault();
      event.returnValue = "";
    }
  };
  const visibility = () => {
    if (document.visibilityState === "hidden") void props.documents.saveAll();
  };
  const pageHide = () => {
    void props.documents.saveAll();
  };
  onSettled(() => {
    previewMedia.addEventListener("change", onPreviewResize);
    onPreviewResize();
    window.addEventListener("beforeunload", beforeUnload);
    window.addEventListener("pagehide", pageHide);
    document.addEventListener("visibilitychange", visibility);
  });
  onCleanup(() => {
    previewSync.dispose();
    previewMedia.removeEventListener("change", onPreviewResize);
    unsubscribe();
    if (!props.buffers) buffers.clear();
    window.removeEventListener("beforeunload", beforeUnload);
    window.removeEventListener("pagehide", pageHide);
    document.removeEventListener("visibilitychange", visibility);
  });
  const backToTree = () => {
    setMobileVisible(false);
    onSettled(() =>
      document.querySelector<HTMLElement>('[role="tree"]')?.focus(),
    );
  };
  function tabKeyboard(event: KeyboardEvent, id: string) {
    const ids = state().documents.map((document) => document.id);
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
    props.documents.activate(ids[next]);
    onSettled(() => document.getElementById(tabId(ids[next]))?.focus());
  }
  return (
    <section
      aria-label="文件编辑器"
      class={
        (active() || state().loadingPath || state().openError) &&
        mobileVisible()
          ? "vault-editor relative fixed inset-x-0 top-0 bottom-[var(--workspace-status-height)] z-20 flex min-h-0 min-w-0 flex-col bg-surface sm:relative sm:z-auto"
          : "vault-editor relative hidden min-h-0 min-w-0 flex-col bg-surface sm:flex"
      }
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
        <div class="flex shrink-0 items-center gap-2 border-b border-solid border-border px-3 py-2 sm:hidden">
          <IconButton aria-label="返回文件树" size="sm" onClick={backToTree}>
            <ChevronLeft size={16} />
          </IconButton>
          <span class="text-ui-sm text-secondary">文件编辑器</span>
        </div>
        <Show when={state().openError}>
          <p
            role="alert"
            class="border-b border-solid border-border px-4 py-2 text-ui-sm text-danger"
          >
            {state().openError}
          </p>
        </Show>
        <Show when={state().documents.length}>
          <div role="tablist" aria-label="打开的文件" class="editor-tabs">
            <For each={state().documents.map((document) => document.id)}>
              {(id) => {
                const file = () =>
                  state().documents.find((document) => document.id === id)!;
                return (
                  <div
                    class="editor-tab"
                    data-active={state().activeId === id ? "true" : "false"}
                  >
                    <button
                      id={tabId(id)}
                      type="button"
                      role="tab"
                      class="editor-tab-label"
                      aria-label={file().path}
                      aria-controls={panelId}
                      aria-selected={state().activeId === id ? "true" : "false"}
                      tabindex={state().activeId === id ? 0 : -1}
                      title={file().path}
                      onClick={() => {
                        props.documents.activate(id);
                        setMobileVisible(true);
                      }}
                      onKeyDown={(event) => tabKeyboard(event, id)}
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
                      disabled={file().locked || file().saving}
                      onClick={() =>
                        void props.documents.requestCloseDocument(id)
                      }
                    >
                      <X size={13} />
                    </button>
                  </div>
                );
              }}
            </For>
          </div>
        </Show>
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
                <h2 class="text-ui-heading font-medium">打开一份文件</h2>
                <p class="mt-2 text-ui-sm text-secondary">
                  从左侧选择，或新建你的第一份笔记。
                </p>
                <p class="mt-6 text-ui-sm text-secondary">
                  自动保存 <span aria-hidden="true">·</span> Ctrl / ⌘ S 手动保存
                </p>
              </div>
            }
          >
            {(id) => (
              <>
                <header class="editor-toolbar">
                  <span
                    class="min-w-0 flex-1 truncate text-ui-sm text-secondary"
                    title={active()?.path}
                  >
                    {active()?.path}
                  </span>
                  <Show when={canRender()}>
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-pressed={
                        displayMode() === "source" ? "true" : "false"
                      }
                      onClick={() => chooseMode("source")}
                    >
                      源码
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      class="hidden sm:inline-flex"
                      aria-pressed={
                        displayMode() === "split" ? "true" : "false"
                      }
                      onClick={() => chooseMode("split")}
                    >
                      分栏
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-pressed={
                        displayMode() === "preview" ? "true" : "false"
                      }
                      onClick={() => chooseMode("preview")}
                    >
                      预览
                    </Button>
                    <Show when={displayMode() === "split"}>
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-pressed={scrollSync() ? "true" : "false"}
                        onClick={() => setScrollSync((value) => !value)}
                        title="按对应内容同步两侧滚动"
                      >
                        滚动同步
                      </Button>
                    </Show>
                  </Show>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-pressed={wrap() ? "true" : "false"}
                    disabled={wrapFromProject() || !!active()?.readOnlyReason}
                    title={
                      wrapFromProject()
                        ? "由 .celestite/settings.json 提供，编辑该文件后生效"
                        : undefined
                    }
                    onClick={() => void setSetting("editor.wordWrap", !wrap())}
                  >
                    自动换行
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={
                      (!active()?.dirty &&
                        !active()?.pending &&
                        !active()?.core?.historyError) ||
                      active()?.saving ||
                      active()?.locked ||
                      !!active()?.readOnlyReason
                    }
                    onClick={() => void props.documents.requestSave(id)}
                    title="Ctrl / ⌘ S"
                  >
                    <Save size={14} />
                    保存
                  </Button>
                </header>
                <Show when={active()?.error}>
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
                  class="flex min-h-0 min-w-0 flex-1 flex-col"
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
                                previewSync={previewSync}
                                reveal={reveal()}
                                document={active()!}
                                cached={buffers.get(id)}
                                wrap={wrap()}
                                onChange={(content) =>
                                  props.documents.update(id, content)
                                }
                                onComposition={(active) =>
                                  props.documents.composition?.(id, active)
                                }
                                onTransaction={
                                  props.documents.edit
                                    ? (transaction) =>
                                        props.documents.edit!(id, transaction)
                                    : undefined
                                }
                                onUndo={
                                  props.documents.undo
                                    ? (context, redo) => {
                                        void props.documents.undo!(
                                          id,
                                          context,
                                          redo,
                                        );
                                      }
                                    : undefined
                                }
                                onSave={() => {
                                  void props.documents.requestSave(id);
                                }}
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
                      <Show when={canRender() && displayMode() !== "source"}>
                        <DocumentPreview
                          sync={previewSync}
                          document={active()!}
                          documents={props.documents}
                          scrollTop={views.get(id)?.scrollTop ?? 0}
                          fragment={
                            fragment()?.id === id
                              ? fragment()?.value
                              : undefined
                          }
                          onScroll={(scrollTop) =>
                            views.set(id, { mode: mode(), scrollTop })
                          }
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
                            const targetMode = untrack(mode);
                            if (!(await props.documents.open(vaultPath(path))))
                              return false;
                            const targetId =
                              props.documents.snapshot().activeId;
                            if (targetId) {
                              views.set(targetId, {
                                mode: targetMode,
                                scrollTop: views.get(targetId)?.scrollTop ?? 0,
                              });
                              setMode(targetMode);
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
                </div>
                <StatusSlot mount={props.statusMount} class="editor-statusbar">
                  <span
                    role="status"
                    aria-label="保存状态"
                    aria-live="polite"
                    class={active()?.error ? "text-danger" : undefined}
                  >
                    {status()}
                  </span>
                  <span class="hidden sm:inline">
                    {languageName(active()?.path ?? "")}
                  </span>
                  <span class="hidden sm:inline">
                    UTF-8{active()?.bom ? " BOM" : ""} ·{" "}
                    {active()?.lineEnding === "\r\n"
                      ? "CRLF"
                      : active()?.lineEnding === "\r"
                        ? "CR"
                        : "LF"}
                  </span>
                  <Show when={!active()?.readOnlyReason}>
                    <span class="whitespace-nowrap">
                      Ln {cursor().line}, Col {cursor().column}
                    </span>
                  </Show>
                </StatusSlot>
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
