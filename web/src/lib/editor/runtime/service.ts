import { VaultError } from "../../vault/errors";
import { vaultPath } from "../../vault/path";
import { encodeError } from "../rpc";
import { PreviewHost } from "../../preview/host";
import type { PreviewResources } from "../../preview/resources";
import type { PreviewBinding } from "../generated/celestite_core";
import { fileMutation } from "../files";
import { TaskQueue } from "../queue";
import type { EditorHost } from "./host";
import type {
  InstanceIdentity,
  ServiceMethods,
  WorkerMessage,
  WorkerRequest,
  ServiceEvent,
  ServiceDocument,
} from "../contract";
export type EditorWorkerHost = Pick<
  EditorHost,
  | "collaboration"
  | "setView"
  | "anchorsAt"
  | "resolveAnchors"
  | "releaseDocument"
  | "composition"
  | "withSource"
  | "open"
  | "read"
  | "apply"
  | "retryHistory"
  | "retryObservation"
  | "save"
  | "resolve"
  | "flush"
  | "fileOperation"
  | "close"
> & {
  reconnect?: () => Promise<ServiceDocument[]>;
};
export interface EditorServicePort {
  postMessage(message: WorkerMessage): void;
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<WorkerRequest>) => void,
  ): void;
}
type Handlers = {
  [M in keyof ServiceMethods]: (
    params: ServiceMethods[M]["params"],
  ) => ServiceMethods[M]["result"] | Promise<ServiceMethods[M]["result"]>;
};
/** The same serialized service can be carried by a Worker, IPC or an in-process port. */
export async function serveEditor(
  port: EditorServicePort,
  create: (
    emit: (event: ServiceEvent) => void,
    schedule: (task: () => Promise<unknown>) => void,
  ) => Promise<{
    identity: InstanceIdentity;
    host: EditorWorkerHost;
    previewBinding: PreviewBinding;
    previewResources: PreviewResources;
    invalidateResourcesOnTree?: boolean;
    setResourceScope?: (
      scope: import("../../vault/file-system-access").LocalDirectoryHandle,
    ) => Promise<void>;
    dispose: () => void;
  }>,
) {
  const sessionId = crypto.randomUUID();
  let host: EditorWorkerHost;
  let previews: PreviewHost;
  let invalidateResourcesOnTree = false;
  const queue = new TaskQueue();
  let closing = false;
  let release!: () => void;
  function enqueue<T>(task: () => Promise<T>) {
    return queue.run(async () => {
      try {
        return await task();
      } finally {
        if (previews && !closing) await previews.refresh().catch(() => {});
      }
    });
  }
  function fatal(error: unknown) {
    port.postMessage({ kind: "fatal", error: encodeError(error) });
  }
  const handlers: Handlers = {
    collaboration: () => host.collaboration(),
    release_document: ({ id }) => host.releaseDocument(id),
    set_view: ({ viewId, documentId, focused, selection }) =>
      host.setView(viewId, documentId, focused, selection),
    anchors_at: ({ id, version, positions }) =>
      host.anchorsAt(id, version, positions),
    resolve_anchors: ({ id, checkpoint, anchors }) =>
      host.resolveAnchors(id, checkpoint, anchors),
    set_resource_scope: async ({ scope }) => {
      if (!runtime.setResourceScope)
        throw new VaultError("Unsupported", "此 Vault 不支持目录资源授权。");
      // The DOM declaration omits the browser's permission methods.
      await runtime.setResourceScope(
        scope as import("../../vault/file-system-access").LocalDirectoryHandle,
      );
      return previews.invalidateProject();
    },
    reconnect: () => {
      if (!host.reconnect)
        throw new VaultError("Unsupported", "连接不支持重新连接。");
      return host.reconnect();
    },
    preview_subscribe: ({ id }) => previews.subscribe(id, sessionId),
    preview_unsubscribe: ({ subscriptionId }) =>
      previews.unsubscribe(subscriptionId, sessionId),
    preview_retry: ({ id }) => previews.retry(id),
    preview_link: ({ id, taskId, target }) => previews.link(id, taskId, target),
    preview_assets: ({ id, taskId }) => previews.assets(id, taskId),
    composition: ({ id, active }) => host.composition(id, active),
    open: ({ path }) => host.open(vaultPath(path)),
    read: ({ id }) => host.read(id),
    apply: ({ id, command }) => host.apply(id, command),
    retry_history: ({ id }) => host.retryHistory(id),
    retry_observation: ({ id }) => host.retryObservation(id),
    save: ({ id }) => host.save(id),
    resolve: ({ id, action }) => host.resolve(id, action),
    flush: () => host.flush(),
    file: async (params) => {
      try {
        return await host.fileOperation(params.method, params);
      } finally {
        if (fileMutation(params.method))
          await previews.invalidateProject().catch(() => {});
      }
    },
    close: async () => {
      closing = true;
      try {
        await host.close();
        previews.close();
      } catch (error) {
        closing = false;
        throw error;
      }
      release();
    },
  };
  port.addEventListener("message", (event) => {
    const request = event.data;
    if (!request || request.kind !== "request") return;
    const dispatch = async () => {
      if (!host || closing || request.sessionId !== sessionId)
        throw new VaultError("Closed", "编辑服务会话无效或正在关闭。");
      if (!Object.prototype.hasOwnProperty.call(handlers, request.method))
        throw new VaultError("Unsupported", "未知编辑服务命令。");
      // The transport is the only type-erased boundary. Each registered method
      // is checked against the shared request/result contract above.
      const handler = handlers[request.method as keyof Handlers];
      return handler(request.params as never);
    };
    // Network waits yield the host queue; all actual core calls are serialized
    // by EditorHost. Slow IO cannot hold incoming imports or accepted editing.
    const detached = [
      "save",
      "release_document",
      "set_view",
      "open",
      "reconnect",
      "close",
      "file",
      "retry_observation",
    ].includes(request.method);
    const result = detached ? queue.start(dispatch) : queue.run(dispatch);
    void result
      .then(
        (result) =>
          port.postMessage({
            kind: "reply",
            requestId: request.requestId,
            result,
          }),
        (error) =>
          port.postMessage({
            kind: "reply",
            requestId: request.requestId,
            error: encodeError(error),
          }),
      )
      .then(() => {
        // Deliver the command's own outcome first. Preview scheduling is derived
        // work: it must neither replace that outcome nor run before detached IO.
        if (previews && !closing)
          void queue.run(() => previews.refresh()).catch(() => {});
      });
  });
  const runtime = await create(
    (event) => {
      port.postMessage(event);
      if (
        event.kind === "tree" &&
        invalidateResourcesOnTree &&
        previews &&
        !closing
      )
        void queue.run(() => previews.invalidateProject()).catch(() => {});
    },
    (task) => {
      if (!closing) void enqueue(task).catch(fatal);
    },
  );
  host = runtime.host;
  invalidateResourcesOnTree = runtime.invalidateResourcesOnTree ?? false;
  previews = new PreviewHost(
    (ids, consume) => host.withSource(ids, consume),
    runtime.previewBinding,
    (event) => port.postMessage({ kind: "preview", event }),
    (task) => {
      if (!closing) void enqueue(task).catch(() => {});
    },
    runtime.previewResources,
  );
  const lifetime = new Promise<void>((resolve) => {
    release = resolve;
  });
  port.postMessage({ kind: "ready", identity: runtime.identity, sessionId });
  await lifetime;
  runtime.dispose();
}
