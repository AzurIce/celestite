import type { VaultBackend } from "../vault/types";
import type { VaultPath } from "../vault/path";
import type { DocumentSnapshot, DocumentsSnapshot } from "./documents";

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
  can_undo: boolean;
  can_redo: boolean;
  group_open: boolean;
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
/** UI consumes this service contract, never a WASM Document or an IO handle. */
export interface EditorDocument extends DocumentSnapshot {
  core?: EditorProjection;
  pending?: number;
  restoredSelection?: SelectionContext & { revision: number };
}
/** View facade common to local service and the transitional HTTP adapter. */
export interface EditorDocuments {
  readonly treeBackend: VaultBackend;
  snapshot(): DocumentsSnapshot;
  subscribe(listener: (state: DocumentsSnapshot) => void): () => void;
  open(path: VaultPath): Promise<boolean>;
  activate(id: string): void;
  update(id: string, content: string): boolean;
  edit?(id: string, transaction: ViewEdit): boolean;
  undo?(
    id: string,
    context: SelectionContext,
    redo?: boolean,
  ): Promise<boolean>;
  save(id?: string | null): Promise<boolean>;
  saveAll(): Promise<boolean>;
  requestSave(id?: string | null): Promise<boolean>;
  requestCloseDocument(id: string): Promise<boolean>;
  closeDocument(id: string): Promise<boolean>;
  resolveConflict(action: "overwrite" | "discard" | "cancel"): Promise<boolean>;
  has(id: string): boolean;
  hasUnsaved(): boolean;
  close(): Promise<void>;
}
export interface ServiceDocument {
  id: string;
  path: VaultPath;
  content?: string;
  savedContent?: string;
  bom: boolean;
  lineEnding: DocumentSnapshot["lineEnding"];
  readOnlyReason: string | null;
  canPreview: boolean;
  saving: boolean;
  error: string | null;
  conflict: boolean;
  core?: EditorProjection;
}
export interface EditResult {
  document: ServiceDocument;
  edits: TextEdit[];
  restoredSelection?: SelectionContext;
}
export interface ServiceEvent {
  kind: "document";
  sequence: number;
  document: ServiceDocument;
}
export interface RpcError {
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
export type WorkerMessage =
  | { kind: "ready"; identity: InstanceIdentity; sessionId: string }
  | { kind: "reply"; requestId: number; result?: unknown; error?: RpcError }
  | { kind: "fatal"; error: RpcError }
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
  open: { params: { path: VaultPath }; result: ServiceDocument };
  edit: {
    params: {
      id: string;
      version: Version;
      edits: TextEdit[];
      context: SelectionContext;
      userEvent: string;
    };
    result: EditResult;
  };
  undo: {
    params: { id: string; context: SelectionContext; redo: boolean };
    result: EditResult;
  };
  save: { params: { id: string }; result: ServiceDocument };
  retry_history: { params: { id: string }; result: ServiceDocument };
  resolve: {
    params: { id: string; action: "overwrite" | "discard" };
    result: ServiceDocument;
  };
  flush: { params: Record<string, never>; result: void };
  file: {
    params: Record<string, unknown> & { method: string };
    result: unknown;
  };
  close: { params: Record<string, never>; result: void };
}
