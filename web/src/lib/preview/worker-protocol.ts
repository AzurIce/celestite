import type {
  PreviewCompletion,
  PreviewResource,
  PreviewResourceRequest,
  PreviewTask,
} from "./contract";

export type PreviewWorkerRequest =
  | { kind: "execute"; task: PreviewTask }
  | {
      kind: "resources";
      taskId: string;
      resources: Record<string, PreviewResource>;
    };

export type PreviewWorkerReply =
  | { kind: "complete"; completion: PreviewCompletion }
  | {
      kind: "resources";
      taskId: string;
      requests: PreviewResourceRequest[];
    };
