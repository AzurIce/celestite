import type { VaultBackend } from "../vault/types";
import type { VaultPath } from "../vault/path";
import type {
  PreviewAssets,
  DocumentPreviews,
  PreviewEvent,
  PreviewLink,
  PreviewState,
  PreviewSubscription,
} from "./preview/contract";

export interface DocumentSnapshot {
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
  lineEnding: "\n" | "\r\n" | "\r";
  bom: boolean;
}
export interface DocumentsSnapshot {
  connection?: ConnectionState;
  collaboration?: CollaborationSnapshot;
  documents: readonly DocumentSnapshot[];
  activeId: string | null;
  loadingPath: VaultPath | null;
  openError: string | null;
  activation: number;
  conflictPrompt: { id: string; intent: "save" | "close" } | null;
  conflictResolving: boolean;
  conflictError: string | null;
}

export interface Vault {
  vaultId: string;
  historyId: string;
}
export interface InstanceIdentity {
  vault: Vault;
  instanceId: string;
}
export interface DocumentIdentity {
  document_id: string;
  history_id: string;
}
export interface Version {
  identity: DocumentIdentity;
  clocks: Record<string, number>;
}
/** Serialized CRDT positions are opaque outside core. */
export type Anchor = { readonly __anchor: unique symbol };
export type Affinity = "before" | "after";
export interface ResolvedAnchor {
  offset: number;
  refreshed: Anchor;
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
  durableVersion: Version | null;
  backendRevision: string;
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
export interface TextEdit {
  from: number;
  to: number;
  insert: string;
}
export interface SelectionContext {
  ranges: { anchor: number; head: number }[];
  mainIndex: number;
}
export interface UndoState {
  canUndo: boolean;
  canRedo: boolean;
}
export interface UndoContext {
  metadata?: unknown;
  positions: number[];
}
export type BufferCommand =
  | {
      kind: "edit";
      base: Version;
      input:
        { kind: "edits"; edits: TextEdit[] } | { kind: "text"; text: string };
      origin?: string;
      group?: string | null;
      undo: UndoContext;
    }
  | { kind: "undo" | "redo"; base: Version; context: UndoContext }
  | { kind: "import"; packet: SyncPacket; origin?: string; resetUndo?: boolean }
  | { kind: "clear_undo" };
export interface BufferUpdate {
  cause:
    | { kind: "local" | "import"; origin: string }
    | { kind: "undo" | "redo" | "history_cleared" };
  changed: boolean;
  before: Version;
  after: Version;
  beforeLen: number;
  afterLen: number;
  revision: number;
  edits: TextEdit[];
  undo: UndoState;
  restored: UndoContext | null;
  operation: SyncPacket | null;
  pending: boolean;
}
export interface TextSnapshot {
  text: string;
  version: Version;
  revision: number;
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
  durableVersion: Version | null;
  undo: UndoState;
  writerId: string;
  historyError: string | null;
}
/** UI consumes a view projection, never a raw Buffer or an IO handle. */
export interface EditorDocument extends DocumentSnapshot {
  remoteChange?: { before: string; edits: TextEdit[] };
  core?: EditorProjection;
  pending?: number;
  restoredSelection?: SelectionContext & { revision: number };
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
  ): Promise<[Version, ResolvedAnchor[]]>;
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
  lineEnding: DocumentSnapshot["lineEnding"];
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
export interface RpcError {
  writeNotStarted?: boolean;
  code: string;
  message: string;
  path?: string;
  rename?: {
    from: string;
    to: string;
    phase: "copy" | "remove-source";
    cleanup?: RpcError;
  };
}
export type ExternalChangeStatus =
  | { phase: "pending" }
  | { phase: "failed"; code: string; message: string; retryAt: number };
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
    result: [Version, ResolvedAnchor[]];
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

export interface SyncPacket {
  identity: DocumentIdentity;
  kind: "snapshot" | "updates";
  data: number[];
}
