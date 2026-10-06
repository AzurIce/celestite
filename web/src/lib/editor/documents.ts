import type { VaultPath } from "../vault/path";
import type {
  ConnectionState,
  EditorProjection,
  ExternalChangeStatus,
  SelectionContext,
} from "./contract";

export interface DocumentSnapshot {
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
  documents: readonly DocumentSnapshot[];
  activeId: string | null;
  loadingPath: VaultPath | null;
  openError: string | null;
  activation: number;
  conflictPrompt: { id: string; intent: "save" | "close" } | null;
  conflictResolving: boolean;
  conflictError: string | null;
}
