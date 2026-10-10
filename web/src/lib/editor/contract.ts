import type { VaultBackend } from "../vault/types";
import type { VaultPath } from "../vault/path";
import type {
  PreviewAssets,
  DocumentPreviews,
  PreviewEvent,
  PreviewLink,
  PreviewState,
  PreviewSubscription,
} from "../preview/contract";
import type {
  Affinity,
  Anchor,
  BufferCommand,
  ExternalChangeStatus,
  InstanceIdentity,
  LineEnding,
  RpcError,
  SelectionContext,
  TextEdit,
  UndoState,
  Version,
} from "./protocol";
export type * from "./protocol";

/** Visible projection; accepted history remains in Rust and provisional input in its session. */
export interface EditorDocument {
  collaborators?: RemoteSelection[];
  deleted?: boolean;
  conflictResolution?: "local" | "shared";
  inputFailure?: {
    outcome: "rejected" | "unknown" | "projection";
    message: string;
  };
  externalChange?: ExternalChangeStatus | null;
  core?: EditorProjection;
  pending?: number;
  restoredSelection?: SelectionContext & { revision: number };
  remoteChange?: { before: string; edits: TextEdit[] };
  id: string;
  path: VaultPath;
  content: string;
  dirty: boolean;
  saving: boolean;
  locked: boolean;
  error: string | null;
  conflict: boolean;
  reloadVersion: number;
  readOnlyReason: string | null;
  canPreview: boolean;
  lineEnding: LineEnding;
  bom: boolean;
}
export interface DocumentsSnapshot {
  connection?: ConnectionState;
  collaboration?: CollaborationSnapshot;
  documents: readonly EditorDocument[];
  activeId: string | null;
  loadingPath: VaultPath | null;
  openError: string | null;
  activation: number;
  conflictPrompt: { id: string; intent: "save" | "close" } | null;
  conflictResolving: boolean;
  conflictError: string | null;
}

export interface MemberView {
  viewId: string;
  documentId: string;
  focused: boolean;
  selection?: PresenceSelection;
}
export interface PresenceSelection {
  version: Version;
  ranges: { anchor: Anchor; head: Anchor }[];
  mainIndex: number;
}
export interface VersionedSelection {
  version: Version;
  selection: SelectionContext;
}
export interface ViewSelection {
  content: string;
  selection: SelectionContext;
}
export interface RemoteSelection extends SelectionContext {
  sessionId: string;
  viewId: string;
  name: string;
  color: string;
  focused: boolean;
  readOnly: boolean;
}
export interface CollaborationMember {
  sessionId: string;
  readOnly: boolean;
  name: string;
  color: string;
  documents: string[];
  views: MemberView[];
}
export interface CollaborationSnapshot {
  sessionId: string;
  sequence: number;
  members: CollaborationMember[];
}
export interface HostDocument {
  id: string;
  path: string;
  version: Version;
  savedVersion: Version | null;
  persistedVersion: Version | null;
  fileRevision: string;
  dirty: boolean;
  deleted: boolean;
  conflict: boolean;
  error: string | null;
  externalChange?: ExternalChangeStatus | null;
  persistenceError: string | null;
  savedContent: string;
  bom: boolean;
  lineEnding: "\n" | "\r\n" | "\r";
}
export interface ViewEdit {
  edits: TextEdit[];
  content: string;
  before: SelectionContext;
  after: SelectionContext;
  userEvent: string;
}
export interface EditorProjection {
  version: Version;
  persistedVersion: Version | null;
  undo: UndoState;
  peerId: string;
  historyError: string | null;
}
/** Connection state for the remote editor session. */
export interface ConnectionState {
  status: "online" | "offline" | "reconnecting";
  error: string | null;
  unconfirmed?: boolean;
}
export interface EditorDocuments {
  retryObservation?(id: string): Promise<boolean>;
  reconnect?(discardUnconfirmed?: boolean): Promise<void>;
  readonly previews?: DocumentPreviews;
  anchorsAt?(
    id: string,
    version: Version,
    positions: [number, Affinity][],
  ): Promise<Anchor[]>;
  resolveAnchors?(
    id: string,
    checkpoint: Version,
    anchors: Anchor[],
  ): Promise<[Version, number[]]>;
  setView?(
    viewId: string,
    documentId: string | null,
    focused: boolean,
    selection?: ViewSelection,
  ): Promise<void>;
  readonly treeBackend: VaultBackend;
  snapshot(): DocumentsSnapshot;
  subscribe(listener: (state: DocumentsSnapshot) => void): () => void;
  open(path: VaultPath): Promise<boolean>;
  activate(id: string): void;
  edit(id: string, transaction: ViewEdit): boolean;
  composition?(id: string, active: boolean): void;
  undo(id: string, context: SelectionContext, redo?: boolean): Promise<boolean>;
  save(id?: string | null): Promise<boolean>;
  saveAll(): Promise<boolean>;
  requestSave(id?: string | null): Promise<boolean>;
  requestCloseDocument(id: string): Promise<boolean>;
  closeDocument(id: string): Promise<boolean>;
  resolveConflict(
    action: "overwrite" | "discard" | "retry" | "cancel",
  ): Promise<boolean>;
  discardRejectedInput?(id: string): Promise<boolean>;
  has(id: string): boolean;
  hasUnsaved(): boolean;
  close(): Promise<void>;
}
export interface ServiceDocument {
  deleted?: boolean;
  conflictResolution?: "local" | "shared";
  externalChange?: ExternalChangeStatus | null;
  change?: { before: Version; edits: TextEdit[] };
  id: string;
  path: VaultPath;
  content?: string;
  savedContent?: string;
  bom: boolean;
  lineEnding: LineEnding;
  readOnlyReason: string | null;
  canPreview: boolean;
  error: string | null;
  conflict: boolean;
  core?: EditorProjection;
}
export interface MutationResult {
  rejection?: RpcError;
  document: ServiceDocument;
  edits: TextEdit[];
  restoredSelection?: SelectionContext;
}
export type ServiceEvent =
  | { kind: "members"; sequence: number; state: CollaborationSnapshot | null }
  | { kind: "document"; sequence: number; document: ServiceDocument }
  | { kind: "tree"; sequence: number }
  | { kind: "connection"; sequence: number; connection: ConnectionState };
export type WorkerMessage =
  | { kind: "ready"; identity: InstanceIdentity; sessionId: string }
  | { kind: "reply"; requestId: number; result?: unknown; error?: RpcError }
  | { kind: "fatal"; error: RpcError }
  | { kind: "preview"; event: PreviewEvent }
  | ServiceEvent;
export interface WorkerRequest {
  kind: "request";
  requestId: number;
  sessionId: string;
  method: string;
  params: Record<string, unknown>;
}

/** Async host operations: identical envelope over Worker messages or native IPC. */
export interface ServiceMethods {
  release_document: { params: { id: string }; result: void };
  collaboration: {
    params: Record<string, never>;
    result: CollaborationSnapshot | null;
  };
  set_view: {
    params: {
      viewId: string;
      documentId: string | null;
      focused: boolean;
      selection: VersionedSelection | null;
    };
    result: void;
  };
  anchors_at: {
    params: { id: string; version: Version; positions: [number, Affinity][] };
    result: Anchor[];
  };
  resolve_anchors: {
    params: { id: string; checkpoint: Version; anchors: Anchor[] };
    result: [Version, number[]];
  };
  read: { params: { id: string }; result: ServiceDocument };
  preview_assets: {
    params: { id: string; taskId: string };
    result: PreviewAssets;
  };
  composition: { params: { id: string; active: boolean }; result: void };
  reconnect: { params: Record<string, never>; result: ServiceDocument[] };
  preview_subscribe: { params: { id: string }; result: PreviewSubscription };
  preview_unsubscribe: { params: { subscriptionId: string }; result: boolean };
  preview_retry: { params: { id: string }; result: PreviewState };
  preview_link: {
    params: { id: string; taskId: string; target: string };
    result: PreviewLink;
  };
  open: { params: { path: VaultPath }; result: ServiceDocument };
  apply: {
    params: { id: string; command: BufferCommand };
    result: MutationResult;
  };
  save: { params: { id: string }; result: ServiceDocument };
  retry_history: { params: { id: string }; result: ServiceDocument };
  set_resource_scope: {
    params: { scope: FileSystemDirectoryHandle };
    result: void;
  };
  retry_observation: { params: { id: string }; result: ServiceDocument };
  resolve: {
    params: { id: string; action: "overwrite" | "discard" | "retry" };
    result: ServiceDocument;
  };
  flush: { params: Record<string, never>; result: void };
  file: {
    params: Record<string, unknown> & { method: string };
    result: unknown;
  };
  close: { params: Record<string, never>; result: void };
}
