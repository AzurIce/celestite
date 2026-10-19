import { decodeError } from "./rpc";
import type {
  BufferUpdate,
  ExternalChangeStatus,
  RpcError,
  UndoState,
  Version,
} from "./protocol";

export interface CorePort {
  call(method: string, params: Record<string, unknown>): Promise<CoreReply>;
}
export interface CoreTextSnapshot {
  text: string;
  stateRevision: number;
}
export interface CoreDocument {
  externalChange?: ExternalChangeStatus | null;
  id: string;
  path: string;
  version: Version;
  snapshot: CoreTextSnapshot;
  undo: UndoState;
  peerId: string;
  savedContent: string;
  savedVersion: Version | null;
  dirty: boolean;
  bom: boolean;
  lineEnding: "\n" | "\r\n" | "\r";
  deleted: boolean;
  conflict: boolean;
  recoveryError: string | null;
  recoveryDelay: number | null;
  error: string | null;
  autosaveDelay: number | null;
  fileRevision: string;
}
export interface CoreMutation {
  document: CoreDocument;
  update: BufferUpdate;
}
export type CoreReply =
  | { status: "ok"; value: unknown; mutations: CoreMutation[] }
  | { status: "error"; error: RpcError; mutations: CoreMutation[] };

/** JSON belongs to the WASM ABI; platform-neutral callers exchange values. */
export function wasmCore(binding: {
  call(method: string, params: string): Promise<string>;
}): CorePort {
  return {
    async call(method, params) {
      try {
        return JSON.parse(
          await binding.call(method, JSON.stringify(params)),
        ) as CoreReply;
      } catch (error) {
        let decoded: RpcError;
        try {
          decoded = JSON.parse(String(error));
        } catch {
          throw error;
        }
        throw decodeError(decoded);
      }
    },
  };
}

/** The owner consumes mutations BEFORE interpreting an explicit command error. */
export function coreValue<T>(reply: CoreReply): T {
  if (reply.status === "error") throw decodeError(reply.error);
  return reply.value as T;
}
