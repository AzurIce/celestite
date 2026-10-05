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
  PreviewDiagnostic,
} from "@/lib/editor/preview/contract";
import contentStyle from "./preview-content.css?inline";
import type { PreviewSync } from "./preview-sync";
import "./preview.css";
import { loadComponents } from "@/lib/editor/preview/components";

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
  authorizeResources?: () => Promise<void>;
  scrollTop: number;
  fragment?: string;
  sync: PreviewSync;
  onScroll: (top: number) => void;
  onReveal: (from: number, to: number, keepSplit?: boolean) => void;
  onNavigate: (path: string, fragment: string | null) => Promise<boolean>;
  onDiagnostic: (diagnostic: PreviewDiagnostic) => Promise<void>;
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
  const [packageDiagnostic, setPackageDiagnostic] =
    createSignal<PreviewDiagnostic | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [unavailable, setUnavailable] = createSignal(false);
  const [loadingComponents, setLoadingComponents] = createSignal(false);
  const [authorizing, setAuthorizing] = createSignal(false);
  let loadingTask: string | undefined;
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
        ? loadingComponents()
          ? "正在加载组件…"
          : "预览已更新"
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
      // HTML and component identities come from the same accepted Rust result.
      article.innerHTML = result.output.html;
      mountedResult = result;
      scroller.scrollTop = top;
      setError(null);
      setPackageDiagnostic(null);
    }
    if (
      data.ready &&
      loadingTask !== result.ticket.taskId &&
      result.output.usedComponents?.length
    ) {
      loadingTask = result.ticket.taskId;
      setLoadingComponents(true);
      void documents
        .previews!.assets(documentId, result.ticket.taskId)
        .then((assets) => {
          if (
            disposed ||
            untrack(() => state()?.target.taskId) !== result.ticket.taskId
          )
            return;
          return loadComponents(result.output.usedComponents, assets);
        })
        .catch((error) => {
          if (
            !disposed &&
            untrack(() => state()?.target.taskId) === result.ticket.taskId
          )
            setError(String(error));
        })
        .finally(() => {
          if (!disposed && loadingTask === result.ticket.taskId) {
            setLoadingComponents(false);
            sync.layoutChanged();
          }
        });
    } else if (!result.output.usedComponents?.length)
      setLoadingComponents(false);
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
      if (event.defaultPrevented) return;
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
      // Links inside a component belong to that component's own document.
      if (anchor.getRootNode() !== root) return;
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
  const diagnostics = () =>
    state()?.status === "failed"
      ? (state()?.diagnostics ?? [])
      : (state()?.result?.output.diagnostics ?? []);
  createEffect(displayData, (data) => {
    latestDisplay = data;
    untrack(() => display(data));
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
        <Button
          size="sm"
          variant="ghost"
          disabled={
            state()?.status === "pending" || state()?.status === "computing"
          }
          onClick={() => {
            setError(null);
            void documents
              .previews!.retry(documentId)
              .catch((error) => setError(String(error)));
          }}
        >
          {state()?.status === "failed" || unavailable()
            ? "重试预览"
            : "刷新预览"}
        </Button>
        <Show when={props.authorizeResources}>
          <Button
            size="sm"
            variant="ghost"
            disabled={authorizing()}
            title="选择包含当前 Vault 和依赖的共同父目录，Vault 根目录保持不变"
            onClick={() => {
              setError(null);
              setAuthorizing(true);
              void props.authorizeResources!()
                .catch((error) =>
                  setError(
                    error instanceof Error ? error.message : String(error),
                  ),
                )
                .finally(() => setAuthorizing(false));
            }}
          >
            {authorizing() ? "正在授权…" : "授权依赖目录"}
          </Button>
        </Show>
      </div>
      <Show
        when={
          props.authorizeResources &&
          state()?.status === "failed" &&
          /外部 package|授权目录|读取权限|NotAllowedError/.test(
            state()?.error ?? "",
          )
        }
      >
        <p class="preview-error">
          依赖超出当前授权范围或授权已失效，请选择包含 Vault
          和依赖的共同父目录。
        </p>
      </Show>
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
      <Show when={diagnostics().length}>
        <details class="preview-diagnostics">
          <summary>预览诊断（{diagnostics().length}）</summary>
          <For each={diagnostics()}>
            {(diagnostic) => (
              <button
                type="button"
                disabled={diagnostic.source === null && !current()}
                onClick={() => {
                  if (
                    diagnostic.path.startsWith("/") &&
                    diagnostic.source !== null
                  ) {
                    setPackageDiagnostic(diagnostic);
                    return;
                  }
                  if (
                    diagnostic.source === null &&
                    diagnostic.path === props.document.path
                  )
                    props.onReveal(diagnostic.from, diagnostic.to);
                  else
                    void props.onDiagnostic(diagnostic).catch((error) => {
                      if (!disposed) setError(String(error));
                    });
                }}
              >
                {diagnostic.source !== null ? `${diagnostic.path}: ` : ""}
                {diagnostic.message}
              </button>
            )}
          </For>
        </details>
      </Show>
      <Show when={packageDiagnostic()}>
        {(diagnostic) => (
          <section class="preview-package-source" aria-label="package 诊断源码">
            <div>
              <span>{diagnostic().path} · 只读</span>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setPackageDiagnostic(null)}
              >
                关闭源码
              </Button>
            </div>
            <pre tabindex={0}>
              {diagnostic().source!.slice(0, diagnostic().from)}
              <mark>
                {diagnostic().source!.slice(diagnostic().from, diagnostic().to)}
              </mark>
              {diagnostic().source!.slice(diagnostic().to)}
            </pre>
          </section>
        )}
      </Show>
    </section>
  );
}
