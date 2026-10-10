import type { Compartment, EditorState } from "@codemirror/state";

/** UI-owned CodeMirror cache retained for an EditorDocuments lifetime across view switches. */
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
