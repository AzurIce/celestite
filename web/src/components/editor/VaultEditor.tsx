import {
  For,
  Loading,
  Show,
  createEffect,
  createSignal,
  lazy,
  onCleanup,
  onSettled,
} from "solid-js";
import { Button, IconButton } from "@/components/ui";
import { ChevronLeft, LoaderCircle, Save } from "@/components/icons";
import type {
  EditorDocuments,
  ExternalChangeStatus,
} from "@/lib/editor/contract";
import type { PreviewModeSetting } from "@/lib/settings/schema";
import type { EditorBuffer } from "./buffer";
import { EditorTabs } from "./EditorTabs";
import { EditorStatus } from "./EditorStatus";

import type { VimMode } from "./vim";
import { SaveConflict } from "./SaveConflict";
import { DocumentPreview } from "./DocumentPreview";
import { PreviewSync } from "./preview-sync";
import { CollaborationBar } from "./CollaborationBar";
import { vaultPath } from "@/lib/vault/path";
import "./editor.css";

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
}

export interface EditorViewSettings {
  previewMode: PreviewModeSetting;
  wordWrap: boolean;
  vimMode: boolean;
  wordWrapFromProject: boolean;
}

export function VaultEditor(props: VaultEditorProps) {
  const previewSync = new PreviewSync();
  const [scrollSync, setScrollSync] = createSignal(true);
  const [state, setState] = createSignal(props.documents.snapshot());
  const unsubscribe = props.documents.subscribe(setState);
  const [mobileVisible, setMobileVisible] = createSignal(false);
  const [cursor, setCursor] = createSignal({ line: 1, column: 1 });
  const [vimMode, setVimMode] = createSignal<VimMode | null>(null);
  const [closingTabs, setClosingTabs] = createSignal(false);
  const mode = () => props.settings.previewMode;
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
  onSettled(() => {
    previewMedia.addEventListener("change", onPreviewResize);
    onPreviewResize();
  });
  onCleanup(() => {
    previewSync.dispose();
    previewMedia.removeEventListener("change", onPreviewResize);
    unsubscribe();
  });
  const backToTree = () => {
    setMobileVisible(false);
    onSettled(() =>
      document.querySelector<HTMLElement>('[role="tree"]')?.focus(),
    );
  };
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
        <EditorTabs
          state={state()}
          panelId={panelId}
          canClose={canCloseTabs}
          onClose={(ids) => void closeTabs(ids)}
          onActivate={(id) => {
            props.documents.activate(id);
            setMobileVisible(true);
          }}
        />
        <Show when={state().collaboration}>
          {(members) => (
            <CollaborationBar state={members()} documentId={state().activeId} />
          )}
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
                    <For
                      each={[
                        { mode: "source" as const, label: "源码" },
                        { mode: "split" as const, label: "分栏" },
                        { mode: "preview" as const, label: "预览" },
                      ]}
                    >
                      {(item) => (
                        <Button
                          size="sm"
                          variant="ghost"
                          class={
                            item.mode === "split"
                              ? "hidden sm:inline-flex"
                              : undefined
                          }
                          aria-pressed={
                            displayMode() === item.mode ? "true" : "false"
                          }
                          onClick={() => chooseMode(item.mode)}
                        >
                          {item.label}
                        </Button>
                      )}
                    </For>
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
                    onClick={() =>
                      props.onSettingsChange({ wordWrap: !wrap() })
                    }
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
                      !!active()?.externalChange ||
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
                      <Show when={canRender() && displayMode() !== "source"}>
                        <DocumentPreview
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
                </div>
                <EditorStatus
                  document={active()!}
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
