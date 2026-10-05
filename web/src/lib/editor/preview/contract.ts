import type { Version } from "../contract";

/** Mirrors Rust preview.rs. UI input projections are never analysis snapshots. */
export interface PreviewTicket {
  taskId: string;
  sessionId: string;
  documentId: string;
  version: Version;
  path: string;
  renderGeneration: string;
}
export interface PreviewTask {
  ticket: PreviewTicket;
  source: string;
  overlays: Record<string, string>;
  resources: Record<string, PreviewResource>;
  resourceRoot: string;
}
export interface PreviewResource {
  kind: "file" | "directory" | null;
  data: number[] | null;
  error: string | null;
}
export interface PreviewResourceRequest {
  path: string;
  read: boolean;
}
/** Host-provided package IO, separate from editable Vault file operations. */
export interface PackageResourceProvider {
  root: string;
  read(
    request: PreviewResourceRequest,
    task: PreviewTask,
  ): Promise<PreviewResource>;
  readDir(
    path: string,
    task: PreviewTask,
  ): Promise<{ path: string; kind: string }[]>;
}
export interface PreviewComponent {
  package: string;
  name: string;
  tag: string;
  path: string;
  packageRoot: string;
}
export interface PreviewAssets {
  digest: string;
  files: { path: string; data: Uint8Array }[];
}
export type PreviewWorkerMessage =
  | PreviewCompletion
  | {
      kind: "resources";
      taskId: string;
      requests: PreviewResourceRequest[];
    };
export interface PreviewDiagnostic {
  from: number;
  to: number;
  origin: "analysis" | "transform" | "render" | "environment";
  phase: string;
  message: string;
  path: string;
  source: string | null;
}
export interface PreviewOutput {
  html: string;
  diagnostics: PreviewDiagnostic[];
  sourceMap: PreviewSourceMapping[];
  usedComponents: PreviewComponent[];
}
export interface PreviewSourceMapping {
  nodeId: number;
  from: number;
  to: number;
  kind: "block" | "inline" | "container";
}
export interface PreviewCompletion {
  taskId: string;
  outcome:
    | { kind: "success"; output: PreviewOutput }
    | { kind: "failure"; message: string; diagnostics?: PreviewDiagnostic[] };
}
export interface PreviewResult {
  ticket: PreviewTicket;
  output: PreviewOutput;
}
export interface PreviewState {
  target: PreviewTicket;
  status: "unsupported" | "pending" | "computing" | "ready" | "failed";
  result: PreviewResult | null;
  error: string | null;
  diagnostics: PreviewDiagnostic[];
  dueAt: number | null;
}
export interface PreviewSubscription {
  subscriptionId: string;
  state: PreviewState;
}
export interface PreviewEvent {
  sequence: number;
  documentId: string;
  state: PreviewState | null;
}
export type PreviewLink =
  | { kind: "fragment"; fragment: string }
  | { kind: "document"; path: string; fragment: string | null }
  | { kind: "external"; url: string };
export interface DocumentPreviews {
  subscribe(
    id: string,
    listener: (state: PreviewState | null) => void,
  ): () => void;
  retry(id: string): Promise<void>;
  link(id: string, taskId: string, target: string): Promise<PreviewLink>;
  assets(id: string, taskId: string): Promise<PreviewAssets>;
}

/** Executor operations are internal to the platform wrapper, not UI commands. */
export interface PreviewCoreMethods {
  preview_subscribe: {
    params: { id: string; clientSession: string };
    result: PreviewSubscription;
  };
  preview_unsubscribe: {
    params: { subscriptionId: string; clientSession: string };
    result: boolean;
  };
  preview_state: { params: { id: string }; result: PreviewState };
  preview_release_client: {
    params: { clientSession: string };
    result: null;
  };
  preview_take_task: { params: { id: string }; result: PreviewTask | null };
  preview_complete: {
    params: { completion: PreviewCompletion };
    result: boolean;
  };
  preview_retry: { params: { id: string }; result: PreviewState };
  preview_events: { params: Record<string, never>; result: PreviewEvent[] };
  preview_invalidate_project: { params: Record<string, never>; result: null };
  preview_link: {
    params: { id: string; taskId: string; target: string };
    result: PreviewLink;
  };
}
