/** Wire values shared with Rust and the collaboration transport.
 * No UI, filesystem handles or application settings belong here. */
import type { DocumentIdentity, Version } from "./generated/celestite_core";
export type { DocumentIdentity, Version } from "./generated/celestite_core";

export const PROTOCOL_VERSION = 4;

export interface Vault {
  vaultId: string;
  historyId: string;
}
export interface InstanceIdentity {
  vault: Vault;
  instanceId: string;
}
export type LineEnding = "\n" | "\r\n" | "\r";
/** Serialized CRDT positions are opaque outside core. */
export type Anchor = { readonly __anchor: unique symbol };
export type Affinity = "before" | "after";
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
      group?: string | null;
      undo: UndoContext;
    }
  | { kind: "undo" | "redo"; base: Version; context: UndoContext }
  | { kind: "import"; packet: HistoryPacket; resetUndo?: boolean }
  | { kind: "clear_undo" };
export interface BufferUpdate {
  cause: { kind: "local" | "import" | "undo" | "redo" | "history_cleared" };
  changed: boolean;
  before: Version;
  after: Version;
  beforeLen: number;
  afterLen: number;
  stateRevision: number;
  edits: TextEdit[];
  undo: UndoState;
  restored: UndoContext | null;
  operation: HistoryPacket | null;
  pending: boolean;
}
export interface TextSnapshot {
  text: string;
  version: Version;
  stateRevision: number;
}
export interface HistoryPacket {
  identity: DocumentIdentity;
  kind: "snapshot" | "updates";
  data: number[];
}
export type ExternalChangeStatus =
  | { phase: "pending" }
  | { phase: "failed"; code: string; message: string; retryAt: number };
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

export function sameVersion(a: Version, b: Version): boolean {
  return (
    a.identity.document_id === b.identity.document_id &&
    a.identity.history_id === b.identity.history_id &&
    Object.keys(a.clocks).length === Object.keys(b.clocks).length &&
    Object.entries(a.clocks).every(([peer, clock]) => b.clocks[peer] === clock)
  );
}
