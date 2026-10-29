import { StateEffect, StateField, type Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";

export const setComposing = StateEffect.define<boolean>();

/** One composition state for the source projection and its presentation. */
export const compositionState = StateField.define<boolean>({
  create: () => false,
  update(active, transaction) {
    // A final browser commit can arrive after compositionend. Mark it before
    // the view's transaction listener forwards the edit to the document session.
    if (transaction.isUserEvent("input.type.compose")) active = true;
    for (const effect of transaction.effects)
      if (effect.is(setComposing)) active = effect.value;
    return active;
  },
});

/** Observe both contenteditable and Android's public EditContext event source. */
export function editorComposition(
  onChange: (active: boolean) => void,
): Extension {
  return [
    compositionState,
    ViewPlugin.fromClass(
      class {
        private context: EventTarget | null = null;
        private timer?: ReturnType<typeof setTimeout>;
        private frame?: number;
        private destroyed = false;
        constructor(readonly view: EditorView) {
          // CodeMirror attaches EditContext after constructing view plugins.
          queueMicrotask(() => {
            if (!this.destroyed) this.bindContext();
          });
        }
        private bindContext() {
          const context =
            (
              this.view.contentDOM as HTMLElement & {
                editContext?: EventTarget | null;
              }
            ).editContext ?? null;
          if (context === this.context) return;
          this.context?.removeEventListener("compositionstart", this.start);
          this.context?.removeEventListener("compositionend", this.end);
          this.context = context;
          context?.addEventListener("compositionstart", this.start);
          context?.addEventListener("compositionend", this.end);
        }
        private cancelEnd() {
          clearTimeout(this.timer);
          if (this.frame !== undefined) {
            this.view.dom.ownerDocument.defaultView!.cancelAnimationFrame(
              this.frame,
            );
            this.frame = undefined;
          }
        }
        start = () => {
          this.cancelEnd();
          if (!this.view.state.field(compositionState))
            this.view.dispatch({ effects: setComposing.of(true) });
        };
        end = () => {
          this.cancelEnd();
          // Android's DOM adapter flushes end-of-composition changes in rAF.
          // Register after the event so its flush runs before we rebuild any
          // decorations or import held changes, including a final late input.
          this.timer = setTimeout(() => {
            this.frame =
              this.view.dom.ownerDocument.defaultView!.requestAnimationFrame(
                () => {
                  this.frame = undefined;
                  if (
                    !this.destroyed &&
                    !this.view.compositionStarted &&
                    this.view.state.field(compositionState)
                  )
                    this.view.dispatch({ effects: setComposing.of(false) });
                },
              );
          }, 0);
        };
        update(update: ViewUpdate) {
          // Editable changes attach/detach the context later in this update.
          queueMicrotask(() => {
            if (!this.destroyed) this.bindContext();
          });
          const active = update.state.field(compositionState);
          if (
            active !==
            (update.startState.field(compositionState, false) ?? false)
          )
            onChange(active);
          if (
            active &&
            !this.view.compositionStarted &&
            update.transactions.some((transaction) =>
              transaction.isUserEvent("input.type.compose"),
            )
          )
            this.end();
        }
        destroy() {
          this.destroyed = true;
          this.cancelEnd();
          this.context?.removeEventListener("compositionstart", this.start);
          this.context?.removeEventListener("compositionend", this.end);
        }
      },
      {
        eventHandlers: {
          compositionstart() {
            this.start();
            return false;
          },
          compositionend() {
            this.end();
            return false;
          },
        },
      },
    ),
  ];
}
