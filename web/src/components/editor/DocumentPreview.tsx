import {
  For,
  Show,
  createEffect,
  createSignal,
  onCleanup,
  onSettled,
  untrack,
} from "solid-js";
import { Button } from "@/components/ui";
import type {
  EditorDocument,
  EditorDocuments,
  Version,
} from "@/lib/editor/contract";
import type {
  PreviewResult,
  PreviewState,
} from "@/lib/editor/preview/contract";
import contentStyle from "./preview-content.css?inline";
import type { PreviewSync } from "./preview-sync";
import "./preview.css";

function sameVersion(a: Version, b: Version) {
  return (
    a.identity.document_id === b.identity.document_id &&
    a.identity.history_id === b.identity.history_id &&
    Object.keys(a.clocks).length === Object.keys(b.clocks).length &&
    Object.entries(a.clocks).every(
      ([writer, clock]) => b.clocks[writer] === clock,
    )
  );
}
export function DocumentPreview(props: {
  document: EditorDocument;
  documents: EditorDocuments;
  scrollTop: number;
  fragment?: string;
  sync: PreviewSync;
  onScroll: (top: number) => void;
  onReveal: (from: number, to: number, keepSplit?: boolean) => void;
  onNavigate: (path: string, fragment: string | null) => Promise<boolean>;
}) {
  let host!: HTMLDivElement;
  let scroller!: HTMLDivElement;
  let root: ShadowRoot | undefined;
  let article: HTMLElement | undefined;
  let mountedResult: PreviewResult | undefined;
  let appliedFragment: string | undefined;
  let disposed = false;
  const initialScrollTop = untrack(() => props.scrollTop);
  const documents = untrack(() => props.documents);
  const documentId = untrack(() => props.document.id);
  const sync = untrack(() => props.sync);
  const onReveal = untrack(() => props.onReveal);
  let detachSync: (() => void) | undefined;
  let pointerDown: { x: number; y: number } | undefined;
  const [state, setState] = createSignal<PreviewState | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [unavailable, setUnavailable] = createSignal(false);
  const unsubscribe = documents.previews!.subscribe(documentId, (value) => {
    setUnavailable(value === null);
    setState(value);
  });
  const current = () => {
    const result = state()?.result;
    const version = props.document.core?.version;
    return (
      state()?.status === "ready" &&
      !!result &&
      !!version &&
      !props.document.pending &&
      sameVersion(result.ticket.version, version)
    );
  };
  const status = () =>
    state()?.status === "failed" || unavailable()
      ? "预览失败"
      : current()
        ? "预览已更新"
        : state()?.result
          ? "预览正在更新…"
          : "正在生成预览…";
  function fragment(id: string) {
    sync.navigatePreview();
    if (!id) {
      scroller.scrollTop = 0;
      return;
    }
    const element = root?.getElementById(id);
    if (element) element.scrollIntoView({ block: "start" });
    else setError(`找不到预览中的位置：${id}`);
  }
  const displayData = () => ({
    result: state()?.result,
    ready: current(),
    fragment: props.fragment,
  });
  let latestDisplay: ReturnType<typeof displayData> = {
    result: undefined,
    ready: false,
    fragment: undefined,
  };
  function display(data: ReturnType<typeof displayData>) {
    const { result } = data;
    if (!article || !result) {
      sync.setPreview(result ?? undefined, data.ready);
      return;
    }
    if (mountedResult?.ticket.taskId !== result.ticket.taskId) {
      const top = mountedResult ? scroller.scrollTop : initialScrollTop;
      // Only default notist-html output from the internal executor reaches here.
      article.innerHTML = result.output.html;
      mountedResult = result;
      scroller.scrollTop = top;
    }
    sync.setPreview(result, data.ready);
    if (
      data.ready &&
      data.fragment !== undefined &&
      data.fragment !== appliedFragment
    ) {
      fragment(data.fragment);
      appliedFragment = data.fragment;
    }
  }
  onSettled(() => {
    root = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = contentStyle;
    article = document.createElement("article");
    root.append(style, article);
    detachSync = sync.mountPreview(documentId, scroller, article);
    display(latestDisplay);
    root.addEventListener("pointerdown", (event) => {
      if (!(event instanceof PointerEvent)) return;
      pointerDown = { x: event.clientX, y: event.clientY };
    });
    root.addEventListener("click", (event) => {
      if (!(event instanceof MouseEvent)) return;
      const down = pointerDown;
      pointerDown = undefined;
      if (
        down &&
        Math.hypot(event.clientX - down.x, event.clientY - down.y) > 4
      )
        return;
      const anchor = event
        .composedPath()
        .find((element) => element instanceof HTMLAnchorElement) as
        HTMLAnchorElement | undefined;
      if (!anchor) {
        const mapping = sync.previewClick(event);
        if (mapping) onReveal(mapping.from, mapping.to, true);
        return;
      }
      event.preventDefault();
      const target = anchor.getAttribute("href");
      const result = untrack(() => state()?.result);
      if (target === null || !result) return;
      setError(null);
      sync.navigatePreview();
      void documents
        .previews!.link(documentId, result.ticket.taskId, target)
        .then(async (link) => {
          if (disposed) return;
          if (link.kind === "fragment") fragment(link.fragment);
          else if (link.kind === "document") {
            if (
              !(await untrack(() =>
                props.onNavigate(link.path, link.fragment),
              )) &&
              !disposed
            )
              setError(`无法打开 ${link.path}`);
          } else {
            window.open(
              new URL(link.url, location.href).href,
              "_blank",
              "noopener,noreferrer",
            );
          }
        })
        .catch((error) => {
          if (!disposed)
            setError(error instanceof Error ? error.message : String(error));
        });
    });
  });
  createEffect(displayData, (data) => {
    latestDisplay = data;
    display(data);
  });
  onCleanup(() => {
    disposed = true;
    detachSync?.();
    untrack(() =>
      props.onScroll(mountedResult ? scroller.scrollTop : initialScrollTop),
    );
    unsubscribe();
  });
  return (
    <section class="document-preview" aria-label="文档预览">
      <div class="preview-status">
        <span role="status" aria-label="预览状态">
          {status()}
        </span>
        <Show when={state()?.status === "failed" || unavailable()}>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setError(null);
              void documents
                .previews!.retry(documentId)
                .catch((error) => setError(String(error)));
            }}
          >
            重试预览
          </Button>
        </Show>
      </div>
      <Show when={state()?.error || error()}>
        <p class="preview-error" role="alert">
          {error() ?? state()?.error}
        </p>
      </Show>
      <div
        ref={scroller}
        class="preview-scroller"
        onScroll={() => props.onScroll(scroller.scrollTop)}
      >
        <div ref={host} />
      </div>
      <Show when={state()?.result?.output.diagnostics.length}>
        <details class="preview-diagnostics">
          <summary>
            预览诊断（{state()?.result?.output.diagnostics.length}）
          </summary>
          <For each={state()?.result?.output.diagnostics}>
            {(diagnostic) => (
              <button
                type="button"
                disabled={!current()}
                onClick={() => props.onReveal(diagnostic.from, diagnostic.to)}
              >
                {diagnostic.message}
              </button>
            )}
          </For>
        </details>
      </Show>
    </section>
  );
}
