import type { Compartment, EditorState } from "@codemirror/state";

/** Per-document view state retained by the owning Vault across workspace switches. */
export interface EditorBuffer {
  reloadVersion: number;
  state: EditorState;
  language: Compartment;
  theme: Compartment;
  bindings: Compartment;
  editable: Compartment;
  wrap: Compartment;
  vim: Compartment;
  scrollTop: number;
  scrollLeft: number;
}
