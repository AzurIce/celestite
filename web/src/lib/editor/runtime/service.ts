import { VaultError } from "../../vault/errors";
import { vaultPath, type VaultPath } from "../../vault/path";
import { encodeError } from "../rpc";
import { PreviewHost } from "../../preview/host";
import type { PreviewResources } from "../../preview/resources";
import type { PreviewPort, PreviewExecutor } from "../../preview/contract";
import { LanguageHost, type LanguageWorker } from "../../language/host";
import { fileMutation } from "../files";
import { TaskQueue } from "../queue";
import type {
  InstanceIdentity,
  ServiceMethods,
  ServiceMessage,
  ServiceRequest,
  ServiceEvent,
  ServiceDocument,
  BufferCommand,
  MutationResult,
  CollaborationSnapshot,
  VersionedSelection,
  Version,
  Affinity,
  Anchor,
} from "../contract";
export interface EditorServiceHost {
  collaboration(): CollaborationSnapshot | null;
  setView(
    viewId: string,
    documentId: string | null,
    focused: boolean,
    selection?: VersionedSelection | null,
  ): Promise<void>;
  anchorsAt(
    id: string,
    version: Version,
    positions: [number, Affinity][],
  ): Promise<Anchor[]>;
  resolveAnchors(
    id: string,
    checkpoint: Version,
    anchors: Anchor[],
  ): Promise<[Version, number[]]>;
  releaseDocument(id: string): Promise<void>;
  composition(id: string, active: boolean): Promise<void>;
  withSource<T>(
    ids: readonly string[],
    consume: (
      source: import("../generated/celestite_core").DocumentSourceSnapshot,
    ) => T | Promise<T>,
  ): Promise<T>;
  open(path: VaultPath): Promise<ServiceDocument>;
  read(id: string): Promise<ServiceDocument>;
  apply(id: string, command: BufferCommand): Promise<MutationResult>;
  checkpoint(id: string): Promise<ServiceDocument>;
  retryObservation(id: string): Promise<ServiceDocument>;
  save(id: string): Promise<ServiceDocument>;
  resolve(
    id: string,
    action: "overwrite" | "discard" | "retry",
  ): Promise<ServiceDocument>;
  flush(): Promise<void>;
  fileOperation(
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown>;
  close(): Promise<void>;
  dispose(): void;
  reconnect?: () => Promise<ServiceMethods["reconnect"]["result"]>;
}
export interface EditorServicePort {
  postMessage(message: ServiceMessage): void;
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<ServiceRequest>) => void,
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
    host: EditorServiceHost;
    previewBinding: PreviewPort;
    createPreviewExecutor?: () => PreviewExecutor;
    previewResources: PreviewResources;
    createLanguageWorker?: () => LanguageWorker;
    invalidateResourcesOnTree?: boolean;
    setResourceScope?: (
      scope: import("../../vault/file-system-access").LocalDirectoryHandle,
    ) => Promise<void>;
    releaseOwner?: () => Promise<void>;
    dispose: () => void | Promise<void>;
  }>,
  receiveDetach?: (detach: () => void) => void,
) {
  const sessionId = crypto.randomUUID();
  let host: EditorServiceHost;
  let previews: PreviewHost;
  let language: LanguageHost;
  let invalidateResourcesOnTree = false;
  const queue = new TaskQueue();
  let closing = false;
  let suspended = false;
  const deferred: (() => Promise<unknown>)[] = [];
  let release!: () => void;
  function enqueue<T>(task: () => Promise<T>) {
    return queue.run(async () => {
      try {
        return await task();
      } finally {
        if (previews && !closing && !suspended)
          await previews.refresh().catch(() => {});
      }
    });
  }
  function schedule(task: () => Promise<unknown>) {
    if (closing) return;
    if (suspended) {
      deferred.push(task);
      return;
    }
    void enqueue(async () => {
      if (suspended) {
        deferred.push(task);
        return;
      }
      if (!closing) return task();
    }).catch(fatal);
  }
  function fatal(error: unknown) {
    port.postMessage({ kind: "fatal", error: encodeError(error) });
  }
  function resumeWork() {
    suspended = false;
    previews.resume();
    for (const task of deferred.splice(0)) schedule(task);
    schedule(() => previews.refresh());
  }
  const handlers: Handlers = {
    suspend: async () => {
      suspended = true;
      try {
        await previews.pause();
      } catch (error) {
        resumeWork();
        throw error;
      }
    },
    resume: resumeWork,
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
      language.invalidate();
      return previews.invalidateProject();
    },
    reconnect: () => {
      if (!host.reconnect)
        throw new VaultError("Unsupported", "连接不支持重新连接。");
      return host.reconnect();
    },
    preview_subscribe: ({ id }) => previews.subscribe(id, sessionId),
    // Enqueue-only: language work never blocks the editor command queue.
    language_message: ({ message }) => language.handle(message),
    preview_unsubscribe: ({ subscriptionId }) =>
      previews.unsubscribe(subscriptionId, sessionId),
    preview_retry: ({ id }) => previews.retry(id),
    preview_link: ({ id, taskId, target }) => previews.link(id, taskId, target),
    preview_assets: ({ id, taskId }) => previews.assets(id, taskId),
    composition: ({ id, active }) => host.composition(id, active),
    open: ({ path }) => host.open(vaultPath(path)),
    read: ({ id }) => host.read(id),
    apply: ({ id, command }) => host.apply(id, command),
    checkpoint: ({ id }) => host.checkpoint(id),
    retry_observation: ({ id }) => host.retryObservation(id),
    save: ({ id }) => host.save(id),
    resolve: ({ id, action }) => host.resolve(id, action),
    flush: () => host.flush(),
    file: async (params) => {
      try {
        return await host.fileOperation(params.method, params);
      } finally {
        if (fileMutation(params.method)) {
          language.invalidate();
          await previews.invalidateProject().catch(() => {});
        }
      }
    },
    close: async () => {
      try {
        if (runtime.releaseOwner) {
          // Confirm text checkpoints and remote receipts before suspending IO.
          // Until native release succeeds, transport and subscriptions survive.
          await host.flush();
          suspended = true;
          await previews.pause();
          await runtime.releaseOwner();
          closing = true;
          deferred.length = 0;
          host.dispose();
          previews.dispose();
          language.dispose();
        } else {
          // Closing remains reversible until the core's final checkpoint and
          // backend close succeed. Timers admitted meanwhile must survive a
          // failed close, just as they survive a failed native owner release.
          suspended = true;
          await host.close();
          closing = true;
          deferred.length = 0;
          language.dispose();
          await previews.close();
        }
        await runtime.dispose();
      } catch (error) {
        closing = false;
        resumeWork();
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
      if (suspended && !["resume", "close", "suspend"].includes(request.method))
        throw new VaultError("Busy", "编辑服务正在等待窗口关闭。");
      if (!Object.prototype.hasOwnProperty.call(handlers, request.method))
        throw new VaultError("Unsupported", "未知编辑服务命令。");
      // The transport is the only type-erased boundary. Each registered method
      // is checked against the shared request/result contract above.
      const handler = handlers[request.method as keyof Handlers];
      return handler(request.params as never);
    };
    // Network waits yield the host queue; all actual core calls are serialized
    // by EditorSession. Slow IO cannot hold incoming imports or accepted editing.
    const detached = [
      "save",
      "resolve",
      "checkpoint",
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
        if (previews && !closing && !suspended)
          void queue
            .run(async () => {
              if (!closing && !suspended) await previews.refresh();
            })
            .catch(() => {});
      });
  });
  const runtime = await create((event) => {
    port.postMessage(event);
    if (
      event.kind === "tree" &&
      invalidateResourcesOnTree &&
      previews &&
      !closing
    )
      schedule(() => {
        language.invalidate();
        return previews.invalidateProject();
      });
  }, schedule);
  host = runtime.host;
  invalidateResourcesOnTree = runtime.invalidateResourcesOnTree ?? false;
  previews = new PreviewHost(
    (ids, consume) => host.withSource(ids, consume),
    runtime.previewBinding,
    (event) => port.postMessage({ kind: "preview", event }),
    schedule,
    runtime.previewResources,
    runtime.createPreviewExecutor,
  );
  language = new LanguageHost(
    runtime.previewResources,
    (message) => port.postMessage({ kind: "language", message }),
    runtime.createLanguageWorker,
  );
  const lifetime = new Promise<void>((resolve) => {
    release = resolve;
  });
  receiveDetach?.(() => {
    closing = true;
    deferred.length = 0;
    host.dispose();
    previews.dispose();
    language.dispose();
    release();
  });
  port.postMessage({ kind: "ready", identity: runtime.identity, sessionId });
  await lifetime;
}
