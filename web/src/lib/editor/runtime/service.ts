import { VaultError } from "../../vault/errors";
import { vaultPath } from "../../vault/path";
import { encodeError } from "../rpc";
import { PreviewHost } from "../preview/host";
import type { EditorHost } from "./host";
import type {
  InstanceIdentity,
  SelectionContext,
  TextEdit,
  Version,
  WorkerMessage,
  WorkerRequest,
  ServiceEvent,
  ServiceDocument,
} from "../contract";
export type EditorWorkerHost = Pick<
  EditorHost,
  | "composition"
  | "executePreview"
  | "open"
  | "read"
  | "edit"
  | "undo"
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
export async function serveEditorWorker(
  create: (
    emit: (event: ServiceEvent) => void,
    schedule: (task: () => Promise<unknown>) => void,
  ) => Promise<{
    identity: InstanceIdentity;
    host: EditorWorkerHost;
    dispose: () => void;
  }>,
) {
  const port = self as unknown as {
    postMessage(message: WorkerMessage): void;
    addEventListener(
      type: "message",
      listener: (event: MessageEvent<WorkerRequest>) => void,
    ): void;
  };
  const sessionId = crypto.randomUUID();
  let host: EditorWorkerHost;
  let previews: PreviewHost;
  let queue: Promise<unknown> = Promise.resolve();
  let closing = false;
  let release!: () => void;
  function enqueue(task: () => Promise<unknown>) {
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
    void enqueue(async () => {
      if (!host || closing || request.sessionId !== sessionId)
        throw new VaultError("Closed", "编辑服务会话无效或正在关闭。");
      const p = request.params;
      switch (request.method) {
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
        case "edit":
          return host.edit(
            String(p.id),
            p.version as Version,
            p.edits as TextEdit[],
            p.context as SelectionContext,
            String(p.userEvent),
          );
        case "undo":
          return host.undo(
            String(p.id),
            p.context as SelectionContext,
            Boolean(p.redo),
            p.version as Version | undefined,
          );
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
    }).then(
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
