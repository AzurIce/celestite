import { VaultError } from "../../vault/errors";
import { vaultPath } from "../../vault/path";
import { encodeError } from "../rpc";
import { PreviewHost } from "../preview/host";
import type { EditorHost } from "./host";
import type {
  InstanceIdentity,
  BufferCommand,
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
  | "executePreview"
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
  | "previewResources"
> & {
  reconnect?: () => Promise<ServiceDocument[]>;
  setResourceScope?: (
    scope: import("../../vault/file-system-access").LocalDirectoryHandle,
  ) => Promise<void>;
};
export interface EditorServicePort {
  postMessage(message: WorkerMessage): void;
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<WorkerRequest>) => void,
  ): void;
}
/** The same serialized service can be carried by a Worker, IPC or an in-process port. */
export async function serveEditor(
  port: EditorServicePort,
  create: (
    emit: (event: ServiceEvent) => void,
    schedule: (task: () => Promise<unknown>) => void,
  ) => Promise<{
    identity: InstanceIdentity;
    host: EditorWorkerHost;
    dispose: () => void;
  }>,
) {
  const sessionId = crypto.randomUUID();
  let host: EditorWorkerHost;
  let previews: PreviewHost;
  let queue: Promise<unknown> = Promise.resolve();
  let closing = false;
  let release!: () => void;
  function enqueue<T>(task: () => Promise<T>) {
    const result = queue.then(async () => {
      try {
        return await task();
      } finally {
        if (previews && !closing) await previews.refresh();
      }
    });
    queue = result.catch(() => {});
    return result;
  }
  port.addEventListener("message", (event) => {
    const request = event.data;
    if (!request || request.kind !== "request") return;
    const dispatch = async () => {
      if (!host || closing || request.sessionId !== sessionId)
        throw new VaultError("Closed", "编辑服务会话无效或正在关闭。");
      const p = request.params;
      switch (request.method) {
        case "collaboration":
          return host.collaboration();
        case "release_document":
          return host.releaseDocument(String(p.id));
        case "set_view":
          return host.setView(
            String(p.viewId),
            p.documentId === null ? null : String(p.documentId),
            Boolean(p.focused),
            (p.selection ?? null) as
              import("../contract").VersionedSelection | null,
          );
        case "anchors_at":
          return host.anchorsAt(
            String(p.id),
            p.version as import("../contract").Version,
            p.positions as [number, import("../contract").Affinity][],
          );
        case "resolve_anchors":
          return host.resolveAnchors(
            String(p.id),
            p.checkpoint as import("../contract").Version,
            p.anchors as import("../contract").Anchor[],
          );
        case "set_resource_scope":
          if (!host.setResourceScope)
            throw new VaultError(
              "Unsupported",
              "此 Vault 不支持目录资源授权。",
            );
          await host.setResourceScope(
            p.scope as import("../../vault/file-system-access").LocalDirectoryHandle,
          );
          return previews.invalidateProject();
        case "reconnect":
          if (!host.reconnect)
            throw new VaultError("Unsupported", "连接不支持重新连接。");
          return host.reconnect();
        case "preview_subscribe":
          return host.executePreview("preview_subscribe", {
            id: String(p.id),
            clientSession: sessionId,
          });
        case "preview_unsubscribe":
          return host.executePreview("preview_unsubscribe", {
            subscriptionId: String(p.subscriptionId),
            clientSession: sessionId,
          });
        case "preview_retry":
          return previews.retry(String(p.id));
        case "preview_link":
          return host.executePreview("preview_link", {
            id: String(p.id),
            taskId: String(p.taskId),
            target: String(p.target),
          });
        case "preview_assets":
          return previews.assets(String(p.id), String(p.taskId));
        case "composition":
          return host.composition(String(p.id), Boolean(p.active));
        case "open":
          return host.open(vaultPath(String(p.path)));
        case "read":
          return host.read(String(p.id));
        case "apply":
          return host.apply(String(p.id), p.command as BufferCommand);
        case "retry_history":
          return host.retryHistory(String(p.id));
        case "retry_observation":
          return host.retryObservation(String(p.id));
        case "save":
          return host.save(String(p.id));
        case "resolve":
          return host.resolve(
            String(p.id),
            p.action as "overwrite" | "discard" | "retry",
          );
        case "flush":
          return host.flush();
        case "file":
          return host.fileOperation(String(p.method), p);
        case "close":
          closing = true;
          try {
            await host.close();
            previews.close();
          } catch (error) {
            closing = false;
            throw error;
          }
          release();
          return;
        default:
          throw new VaultError("Unsupported", "未知编辑服务命令。");
      }
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
    const result = detached
      ? enqueue(async () => {
          const pending = dispatch();
          void pending.catch(() => {});
          return { pending };
        })
          .then(({ pending }) => pending)
          .finally(() => {
            if (previews && !closing)
              void enqueue(() => previews.refresh()).catch(() => {});
          })
      : enqueue(dispatch);
    void result.then(
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
    );
  });
  const runtime = await create(
    (event) => port.postMessage(event),
    (task) => {
      if (!closing)
        void enqueue(task).catch((error) =>
          port.postMessage({ kind: "fatal", error: encodeError(error) }),
        );
    },
  );
  host = runtime.host;
  previews = new PreviewHost(
    (method, params) => host.executePreview(method, params),
    (event) => port.postMessage({ kind: "preview", event }),
    (task) => {
      if (!closing) void enqueue(task).catch(() => {});
    },
    host.previewResources,
  );
  const lifetime = new Promise<void>((resolve) => {
    release = resolve;
  });
  port.postMessage({ kind: "ready", identity: runtime.identity, sessionId });
  await lifetime;
  runtime.dispose();
}
