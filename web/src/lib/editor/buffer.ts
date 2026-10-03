import type { Compartment, EditorState } from "@codemirror/state";

/** Per-document view state retained by the owning Vault across workspace switches. */
export interface EditorBuffer {
  state: EditorState;
  language: Compartment;
  theme: Compartment;
  bindings: Compartment;
  editable: Compartment;
  wrap: Compartment;
  scrollTop: number;
  scrollLeft: number;
}
