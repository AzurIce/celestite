import type {
  PreviewResource,
  PreviewResourceRequest,
  ResourceContext,
} from "../preview/contract";

/** Host→worker traffic is id-correlated; the host sends one item at a time. */
export type LanguageWorkerRequest =
  | { kind: "message"; id: number; root: string; message: string }
  | {
      kind: "resources";
      id: number;
      resources: Record<string, PreviewResource>;
    }
  | { kind: "invalidate"; id: number; root: string };

export type LanguageWorkerReply =
  | { kind: "messages"; id: number; messages: string[] }
  | {
      kind: "resources";
      id: number;
      requests: PreviewResourceRequest[];
      context: ResourceContext;
    }
  | { kind: "done"; id: number }
  | { kind: "error"; id: number; message: string };
