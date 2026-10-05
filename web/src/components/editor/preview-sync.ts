import type { EditorView } from "@codemirror/view";
import type {
  PreviewResult,
  PreviewSourceMapping,
} from "@/lib/editor/preview/contract";

type Side = "source" | "preview";
interface MappedElement {
  mapping: PreviewSourceMapping;
  element: HTMLElement;
}
interface Anchor {
  source: number;
  preview: number;
}

function interpolate(anchors: Anchor[], side: Side, offset: number) {
  const other = side === "source" ? "preview" : "source";
  let low = 0,
    high = anchors.length - 1;
  while (low + 1 < high) {
    const middle = (low + high) >> 1;
    if (anchors[middle][side] <= offset) low = middle;
    else high = middle;
  }
  const a = anchors[low],
    b = anchors[high];
  const distance = b[side] - a[side];
  const ratio =
    distance > 0 ? Math.max(0, Math.min(1, (offset - a[side]) / distance)) : 0;
  return a[other] + ratio * (b[other] - a[other]);
}

/** View geometry only. Source ranges and their applicability come from core.
 * User input selects the driver; follower scroll events never drive back.
 */
export class PreviewSync {
  private editor?: { id: string; view: EditorView };
  private preview?: { id: string; scroller: HTMLElement; article: HTMLElement };
  private result?: PreviewResult;
  private ready = false;
  private enabled = false;
  private driver?: Side;
  private motion: "scroll" | "jump" = "jump";
  private alignment?: Anchor;
  private frame = 0;
  private disposed = false;
  private elements: MappedElement[] = [];
  private byId = new Map<string, MappedElement>();
  private blocks?: { from: number; top: number }[];
  private highlighted?: HTMLElement;
  private highlightTimer?: ReturnType<typeof setTimeout>;
  private pointer?: { side: Side; x: number; y: number };
  private observer = new ResizeObserver(() => this.layoutChanged());
  private fontChange = () => this.layoutChanged();

  constructor() {
    document.fonts.addEventListener("loadingdone", this.fontChange);
  }

  setEnabled(enabled: boolean) {
    this.enabled = enabled;
    // Mode switches and restoring cached scroll positions don't choose a driver.
    this.driver = undefined;
    this.alignment = undefined;
  }
  mountEditor(id: string, view: EditorView) {
    this.editor = { id, view };
    this.observer.observe(view.scrollDOM);
    const detach = this.listen("source", view.scrollDOM);
    const click = (event: MouseEvent) => this.sourceClick(view, event);
    view.scrollDOM.addEventListener("click", click);
    this.schedule();
    return () => {
      detach();
      view.scrollDOM.removeEventListener("click", click);
      this.observer.unobserve(view.scrollDOM);
      if (this.editor?.view === view) this.editor = undefined;
    };
  }
  mountPreview(id: string, scroller: HTMLElement, article: HTMLElement) {
    this.preview = { id, scroller, article };
    this.observer.observe(scroller);
    this.observer.observe(article);
    const detach = this.listen("preview", scroller);
    this.rebuild();
    return () => {
      detach();
      this.observer.unobserve(scroller);
      this.observer.unobserve(article);
      if (this.preview?.scroller === scroller) {
        this.preview = undefined;
        this.result = undefined;
        this.ready = false;
        this.rebuild();
      }
    };
  }
  setPreview(result: PreviewResult | undefined, ready: boolean) {
    const changed = this.result?.ticket.taskId !== result?.ticket.taskId;
    this.result = result;
    this.ready = ready;
    if (changed) this.rebuild();
    this.schedule();
  }
  invalidateEditor(view: EditorView) {
    if (this.editor?.view === view) this.ready = false;
  }
  editorLayoutChanged(view: EditorView) {
    if (this.editor?.view === view) this.schedule();
  }
  private usable() {
    return (
      this.ready &&
      !!this.result &&
      !!this.editor &&
      !!this.preview &&
      this.editor.id === this.preview.id &&
      this.result.ticket.documentId === this.preview.id
    );
  }
  private rebuild() {
    this.clearHighlight();
    this.alignment = undefined;
    this.blocks = undefined;
    this.elements = [];
    this.byId.clear();
    if (
      !this.preview ||
      !this.result ||
      this.result.ticket.documentId !== this.preview.id
    )
      return;
    const mappings = new Map(
      (this.result.output.sourceMap ?? []).map((mapping) => [
        String(mapping.nodeId),
        mapping,
      ]),
    );
    for (const element of this.preview.article.querySelectorAll<HTMLElement>(
      "[data-notist-node]",
    )) {
      const key = element.getAttribute("data-notist-node")!;
      const mapping = mappings.get(key);
      if (!mapping || this.byId.has(key)) continue;
      const entry = { mapping, element };
      this.elements.push(entry);
      this.byId.set(key, entry);
    }
    this.schedule();
  }
  layoutChanged() {
    this.blocks = undefined;
    this.schedule();
  }
  /** Fragment/link navigation is independent from scroll following. */
  navigatePreview() {
    this.driver = undefined;
    this.motion = "jump";
  }
  sourceClick(view: EditorView, event: MouseEvent) {
    if (
      !this.usable() ||
      this.editor?.view !== view ||
      event.button !== 0 ||
      this.dragged("source", event)
    )
      return;
    const target = event.target;
    if (!(target instanceof Element) || !target.closest(".cm-content")) return;
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
    if (pos === null) return;
    const candidates = this.elements.filter(
      ({ mapping, element }) =>
        (mapping.kind !== "container" || element.tagName.includes("-")) &&
        mapping.from <= pos &&
        pos <= mapping.to &&
        element.getClientRects().length,
    );
    candidates.sort(
      (a, b) => a.mapping.to - a.mapping.from - (b.mapping.to - b.mapping.from),
    );
    const distance = ({ mapping }: MappedElement) =>
      Math.max(mapping.from - pos, pos - mapping.to, 0);
    const fallback = this.elements.filter(
      (entry) => entry.mapping.kind === "block",
    );
    const entry =
      candidates[0] ??
      (fallback.length ? fallback : this.elements).sort(
        (a, b) => distance(a) - distance(b),
      )[0];
    if (!entry) return;
    this.driver = "source";
    this.motion = "jump";
    const scroller = this.preview!.scroller;
    const rect = entry.element.getBoundingClientRect();
    const top = scroller.getBoundingClientRect().top + scroller.clientTop;
    const bottom = top + scroller.clientHeight;
    const margin = Math.min(
      8,
      Math.max(0, (scroller.clientHeight - rect.height) / 2),
    );
    // A visible target only needs a marker. For nodes taller than the viewport,
    // an already visible portion is enough; range mapping cannot identify a
    // particular displayed character within that node.
    if (!(
      rect.height > bottom - top &&
      rect.bottom > top &&
      rect.top < bottom
    )) {
      if (rect.top < top) scroller.scrollTop += rect.top - top - margin;
      else if (rect.bottom > bottom)
        scroller.scrollTop += Math.min(
          rect.bottom - bottom + margin,
          rect.top - top - margin,
        );
    }
    this.highlight(entry.element);
  }
  previewClick(event: MouseEvent): PreviewSourceMapping | undefined {
    if (!this.usable() || event.button !== 0 || this.dragged("preview", event))
      return;
    for (const element of event.composedPath()) {
      if (!(element instanceof HTMLElement)) continue;
      const entry = this.byId.get(
        element.getAttribute("data-notist-node") ?? "",
      );
      if (!entry || entry.element !== element) continue;
      if (entry.mapping.to > this.editor!.view.state.doc.length) return;
      this.driver = "preview";
      this.motion = "jump";
      this.highlight(element);
      return entry.mapping;
    }
  }
  private highlight(element: HTMLElement) {
    this.clearHighlight();
    this.highlighted = element;
    element.setAttribute("data-notist-sync-target", "");
    this.highlightTimer = setTimeout(() => this.clearHighlight(), 1000);
  }
  private clearHighlight() {
    clearTimeout(this.highlightTimer);
    this.highlighted?.removeAttribute("data-notist-sync-target");
    this.highlighted = undefined;
  }
  private listen(side: Side, element: HTMLElement) {
    const claim = () => {
      // Click navigation can leave the panes deliberately offset. Keep that
      // viewport pair as an anchor when scrolling resumes, rather than snapping
      // back to the previous alignment. Capture before the input scrolls and
      // after CodeMirror has completed any asynchronous reveal.
      if (this.motion === "jump" && this.usable())
        this.alignment = {
          source: this.editor!.view.scrollDOM.scrollTop,
          preview: this.preview!.scroller.scrollTop,
        };
      this.driver = side;
      this.motion = "scroll";
    };
    const key = (event: KeyboardEvent) => {
      if (
        ["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End"].includes(
          event.key,
        )
      )
        claim();
    };
    const pointer = (event: PointerEvent) => {
      if (event.button !== 0) return;
      this.pointer = { side, x: event.clientX, y: event.clientY };
      claim();
    };
    const scroll = () => {
      if (this.driver === side && this.motion === "scroll") this.schedule();
    };
    element.addEventListener("wheel", claim, { passive: true });
    element.addEventListener("touchstart", claim, { passive: true });
    element.addEventListener("pointerdown", pointer, { passive: true });
    element.addEventListener("keydown", key);
    element.addEventListener("scroll", scroll, { passive: true });
    return () => {
      element.removeEventListener("wheel", claim);
      element.removeEventListener("touchstart", claim);
      element.removeEventListener("pointerdown", pointer);
      element.removeEventListener("keydown", key);
      element.removeEventListener("scroll", scroll);
    };
  }
  private dragged(side: Side, event: MouseEvent) {
    const down = this.pointer;
    this.pointer = undefined;
    return (
      down?.side === side &&
      Math.hypot(event.clientX - down.x, event.clientY - down.y) > 4
    );
  }
  private schedule() {
    if (this.disposed || this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      if (
        !this.usable() ||
        !this.enabled ||
        !this.driver ||
        this.motion !== "scroll"
      )
        return;
      const view = this.editor!.view;
      view.requestMeasure({
        key: this,
        read: () => this.measure(),
        write: (anchors) => {
          if (
            !anchors ||
            !this.usable() ||
            !this.enabled ||
            !this.driver ||
            this.motion !== "scroll"
          )
            return;
          const source = view.scrollDOM,
            preview = this.preview!.scroller;
          const from = this.driver === "source" ? source : preview;
          const to = this.driver === "source" ? preview : source;
          const top = interpolate(anchors, this.driver, from.scrollTop);
          if (Math.abs(to.scrollTop - top) > 0.5) to.scrollTop = top;
        },
      });
    });
  }
  private measure(): Anchor[] | undefined {
    if (!this.usable()) return;
    const { view } = this.editor!;
    const { scroller } = this.preview!;
    if (!this.blocks) {
      const top = scroller.getBoundingClientRect().top + scroller.clientTop;
      this.blocks = this.elements
        // Table cells share a vertical band. Rows, not individual columns, are
        // scroll anchors; cells and inline nodes still support click mapping.
        .filter(
          ({ mapping, element }) =>
            mapping.kind === "block" &&
            !element.closest("td,th") &&
            element.getClientRects().length,
        )
        .map(({ mapping, element }) => ({
          from: mapping.from,
          top: element.getBoundingClientRect().top - top + scroller.scrollTop,
        }))
        .sort((a, b) => a.from - b.from);
    }
    const source = view.scrollDOM;
    const sourceMax = Math.max(0, source.scrollHeight - source.clientHeight);
    const previewMax = Math.max(
      0,
      scroller.scrollHeight - scroller.clientHeight,
    );
    const sourceOrigin =
      view.documentTop -
      source.getBoundingClientRect().top -
      source.clientTop +
      source.scrollTop;
    const anchors: Anchor[] = [{ source: 0, preview: 0 }];
    for (const block of this.blocks) {
      if (block.from > view.state.doc.length) continue;
      const sourceTop = sourceOrigin + view.lineBlockAt(block.from).top - 16;
      const previewTop = block.top - 16;
      const last = anchors[anchors.length - 1];
      // Nested blocks, folded source and same-row cells can repeat positions.
      if (
        sourceTop <= last.source + 0.5 ||
        previewTop <= last.preview + 0.5 ||
        sourceTop >= sourceMax ||
        previewTop >= previewMax
      )
        continue;
      anchors.push({ source: sourceTop, preview: previewTop });
    }
    anchors.push({ source: sourceMax, preview: previewMax });
    if (this.alignment) {
      const current = {
        source: Math.max(0, Math.min(sourceMax, this.alignment.source)),
        preview: Math.max(0, Math.min(previewMax, this.alignment.preview)),
      };
      // Retain the content anchors on either side that preserve monotonicity.
      // This makes the current viewport continuous while still converging to
      // content alignment and the document boundaries as the user scrolls away.
      return [
        ...anchors.filter(
          (anchor) =>
            anchor.source < current.source - 0.5 &&
            anchor.preview < current.preview - 0.5,
        ),
        current,
        ...anchors.filter(
          (anchor) =>
            anchor.source > current.source + 0.5 &&
            anchor.preview > current.preview + 0.5,
        ),
      ];
    }
    return anchors;
  }
  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    this.observer.disconnect();
    document.fonts.removeEventListener("loadingdone", this.fontChange);
    this.clearHighlight();
    this.editor = undefined;
    this.preview = undefined;
    this.elements = [];
    this.byId.clear();
  }
}
