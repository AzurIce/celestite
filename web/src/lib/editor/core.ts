import { decodeError } from "./rpc";
import type {
  BufferUpdate,
  ExternalChangeStatus,
  RpcError,
  TextSnapshot,
  UndoState,
  Version,
} from "./contract";

export interface CorePort {
  call(method: string, params: string): Promise<string>;
}
export interface CoreDocument {
  externalChange?: ExternalChangeStatus | null;
  id: string;
  path: string;
  snapshot: TextSnapshot;
  undo: UndoState;
  writerId: string;
  savedContent: string;
  savedVersion: Version | null;
  dirty: boolean;
  bom: boolean;
  lineEnding: "\n" | "\r\n" | "\r";
  deleted: boolean;
  conflict: boolean;
  durableVersion: Version | null;
  persistenceError: string | null;
  error: string | null;
  autosaveDelay: number | null;
  backendRevision: string;
}
export interface CoreMutation {
  document: CoreDocument;
  update: BufferUpdate;
  history:
    | { status: "committed"; version: Version; durable: boolean }
    | { status: "failed"; error: RpcError };
}
export type CoreReply =
  | { status: "ok"; value: unknown; mutations: CoreMutation[] }
  | { status: "error"; error: RpcError; mutations: CoreMutation[] };

/** Decode only. The owner consumes mutations BEFORE handling a command error. */
export async function callCore(
  core: CorePort,
  method: string,
  params: Record<string, unknown> = {},
): Promise<CoreReply> {
  try {
    return JSON.parse(
      await core.call(method, JSON.stringify(params)),
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
}
export function coreValue<T>(reply: CoreReply): T {
  if (reply.status === "error") throw decodeError(reply.error);
  return reply.value as T;
}
