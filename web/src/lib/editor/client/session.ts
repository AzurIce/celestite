import type {
  EditorDocument,
  SelectionContext,
  ServiceDocument,
  Version,
  ViewEdit,
} from "../contract";
import { mapViewSelection } from "../presence";
import { minimalChange, rebaseInputs, sameVersion } from "../view-changes";

export interface PendingInput extends ViewEdit {
  group: string | null;
}

type MapViews = (
  session: DocumentSession,
  before: string,
  after: string,
  edits: ViewEdit["edits"],
) => void;

export function mapCollaborators(
  session: Pick<DocumentSession, "collaborators">,
  before: string,
  edits: ViewEdit["edits"],
) {
  session.collaborators = session.collaborators?.map((member) => ({
    ...member,
    ...mapViewSelection(member, before.length, edits),
  }));
}

export function applyEdits(
  text: string,
  edits: readonly { from: number; to: number; insert: string }[],
) {
  for (let i = edits.length - 1; i >= 0; i--) {
    const edit = edits[i];
    text = text.slice(0, edit.from) + edit.insert + text.slice(edit.to);
  }
  return text;
}

// The public document fields are initialized from the host snapshot. There is
// one mutable projection, not a second record mirrored by the controller.
export interface DocumentSession extends EditorDocument {}

/** Accepted Rust history, optimistic UI projection and host save confirmation
 * are separate facts. Only this session reconciles the first two. */
export class DocumentSession {
  savedContent: string;
  acceptedContent: string;
  acceptedVersion?: Version;
  inputs: PendingInput[] = [];
  blocked = false;
  #mapViews: MapViews;

  constructor(document: ServiceDocument, mapViews: MapViews) {
    Object.assign(this, document, {
      content: document.content ?? "",
      dirty: false,
      saving: false,
      locked: false,
      reloadVersion: 0,
    });
    this.acceptedContent = document.content ?? "";
    this.acceptedVersion = document.core?.version;
    this.savedContent = document.savedContent ?? "";
    this.#mapViews = mapViews;
  }

  snapshot(): EditorDocument {
    const {
      inputs,
      savedContent,
      acceptedContent,
      acceptedVersion,
      blocked,
      ...document
    } = this;
    return {
      ...document,
      locked: document.locked || blocked,
      dirty: document.content !== savedContent,
      pending: inputs.length,
    };
  }

  private project(content: string, edits: ViewEdit["edits"]) {
    const before = this.content;
    this.#mapViews(this, before, content, edits);
    this.content = content;
  }

  stage(input: PendingInput) {
    this.project(input.content, input.edits);
    this.inputs.push(input);
  }

  fail(outcome: "unknown" | "rejected" | "projection", message: string) {
    this.blocked = true;
    this.error = message;
    this.inputFailure = { outcome, message };
  }

  accept(input: PendingInput, document: ServiceDocument) {
    this.inputs.shift();
    this.acceptedContent = document.content ?? input.content;
    this.acceptedVersion = document.core?.version;
    this.merge(document);
  }

  history(
    document: ServiceDocument,
    edits: ViewEdit["edits"],
    selection?: SelectionContext,
  ) {
    this.content = applyEdits(this.content, edits);
    this.merge(document);
    if (selection)
      this.restoredSelection = {
        ...selection,
        revision: (this.restoredSelection?.revision ?? 0) + 1,
      };
  }

  suspend(message: string) {
    this.blocked = true;
    this.locked = true;
    this.error = message;
  }

  /** Withdrawal includes every later input dependent on the rejected one.
   * Unknown outcomes must be settled or explicitly discarded by reconnect. */
  withdraw(document: ServiceDocument, reconnect = false) {
    this.inputs = [];
    this.blocked = false;
    delete this.inputFailure;
    if (reconnect) {
      this.locked = false;
      delete this.remoteChange;
      delete this.restoredSelection;
    }
    this.merge(document, true);
    this.reloadVersion++;
  }

  merge(document: ServiceDocument, replace = false) {
    const { content, savedContent, change, ...metadata } = document;
    if (change && content !== undefined) {
      if (
        !this.acceptedVersion ||
        !sameVersion(this.acceptedVersion, change.before)
      ) {
        this.fail(
          "projection",
          "远端投影版本不连续，输入仍保留。请复制正文后重新连接。",
        );
        return;
      }
      const before = this.content;
      const rebased = rebaseInputs(
        this.acceptedContent,
        change.edits,
        this.inputs,
      );
      this.acceptedContent = content;
      this.acceptedVersion = document.core?.version;
      this.project(rebased.content, rebased.edits);
      this.remoteChange = { before, edits: rebased.edits };
    } else if (content !== undefined && (replace || this.inputs.length === 0)) {
      if (this.content !== content)
        this.project(content, [minimalChange(this.content, content)]);
      this.acceptedContent = content;
      this.acceptedVersion = document.core?.version;
    }
    Object.assign(this, metadata);
    if (savedContent !== undefined) this.savedContent = savedContent;
    if (document.core?.historyError) this.error = document.core.historyError;
  }
}
