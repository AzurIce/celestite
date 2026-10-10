import type {
  DocumentSourceSnapshot,
  PreviewCompletion,
  PreviewLink,
  PreviewResource,
  PreviewResourceRequest,
  PreviewState,
  PreviewTask,
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
  PreviewTicket,
} from "../editor/generated/celestite_core";

/** A synchronous readonly consumption boundary, independent of Editor and UI. */
export type DocumentSource = <T>(
  ids: readonly string[],
  consume: (source: DocumentSourceSnapshot) => T,
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
export type PreviewWorkerMessage =
  | PreviewCompletion
  | {
      kind: "resources";
      taskId: string;
      requests: PreviewResourceRequest[];
    };
export interface DocumentPreviews {
  subscribe(
    id: string,
    listener: (state: PreviewState | null) => void,
  ): () => void;
  retry(id: string): Promise<void>;
  link(id: string, taskId: string, target: string): Promise<PreviewLink>;
  assets(id: string, taskId: string): Promise<PreviewAssets>;
}
