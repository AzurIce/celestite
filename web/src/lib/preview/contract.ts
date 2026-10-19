import type {
  DocumentSourceSnapshot,
  PreviewCompletion,
  PreviewLink,
  PreviewResource,
  PreviewResourceRequest,
  PreviewState,
  PreviewTask,
  PreviewBinding,
} from "../editor/generated/celestite_core";
export type {
  PreviewCompletion,
  PreviewComponent,
  PreviewDiagnostic,
  PreviewEvent,
  PreviewLink,
  PreviewOutput,
  PreviewResource,
  PreviewResourceRequest,
  PreviewResult,
  PreviewSourceMapping,
  PreviewState,
  PreviewSubscription,
  PreviewTask,
  PreviewBinding,
  PreviewTicket,
} from "../editor/generated/celestite_core";

/** An owned readonly capture, independent of Editor and UI. */
export type DocumentSource = <T>(
  ids: readonly string[],
  consume: (source: DocumentSourceSnapshot) => T | Promise<T>,
) => Promise<T>;

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
export interface PreviewAssets {
  digest: string;
  files: { path: string; data: Uint8Array }[];
}
export interface DocumentPreviews {
  subscribe(
    id: string,
    listener: (state: PreviewState | null) => void,
  ): () => void;
  retry(id: string): Promise<void>;
  link(id: string, taskId: string, target: string): Promise<PreviewLink>;
  assets(id: string, taskId: string): Promise<PreviewAssets>;
}

/** The controller may be local WASM or native IPC; both own identical policy. */
export type PreviewPort = {
  [
    K in
      | "clear"
      | "complete"
      | "events"
      | "invalidate_project"
      | "link"
      | "required_snapshots"
      | "retry"
      | "state"
      | "subscribe"
      | "synchronize"
      | "take_task"
      | "unsubscribe"
      | "free"
  ]: (
    ...args: Parameters<PreviewBinding[K]>
  ) => ReturnType<PreviewBinding[K]> | Promise<ReturnType<PreviewBinding[K]>>;
};
export type PreviewResourceReader = (
  requests: PreviewResourceRequest[],
) => Promise<Record<string, PreviewResource>>;

/** Executes one captured task; the host owns applicability and cancellation. */
export interface PreviewExecutor {
  execute(
    task: PreviewTask,
    readResources: PreviewResourceReader,
    signal: AbortSignal,
  ): Promise<PreviewCompletion>;
  dispose?(): void;
}
