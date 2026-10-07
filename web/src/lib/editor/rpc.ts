import { VaultError, VaultRenameError } from "../vault/errors";
import type { PreviewEvent } from "./preview/contract";
import type {
  ServiceMethods,
  InstanceIdentity,
  RpcError,
  ServiceEvent,
  WorkerMessage,
  WorkerRequest,
} from "./contract";

export interface MessageTransport {
  postMessage(message: WorkerRequest): void;
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<WorkerMessage>) => void,
  ): void;
  removeEventListener(
    type: "message",
    listener: (event: MessageEvent<WorkerMessage>) => void,
  ): void;
}
export function encodeError(error: unknown): RpcError {
  if (error instanceof VaultRenameError)
    return {
      ...encodeError(error.cause),
      rename: {
        from: error.from,
        to: error.to,
        phase: error.phase,
        ...(error.cleanupError
          ? { cleanup: encodeError(error.cleanupError) }
          : {}),
      },
    };
  return {
    ...(error instanceof VaultError && error.writeNotStarted
      ? { writeNotStarted: true }
      : {}),
    code: error instanceof VaultError ? error.code : "IO",
    message: error instanceof Error ? error.message : String(error),
    ...(error instanceof VaultError && error.path !== undefined
      ? { path: error.path }
      : {}),
  };
}
export function decodeError(error: RpcError): VaultError {
  const cause = new VaultError(
    error.code as VaultError["code"],
    error.message,
    error.path,
    undefined,
    error.writeNotStarted,
  );
  return error.rename
    ? new VaultRenameError(
        cause,
        error.rename.from,
        error.rename.to,
        error.rename.phase,
        error.rename.cleanup ? decodeError(error.rename.cleanup) : undefined,
      )
    : cause;
}
/** Request correlation is independent of worker/IPC implementation. No implicit retries. */
export class EditorClient {
  readonly ready: Promise<InstanceIdentity>;
  private resolveReady!: (identity: InstanceIdentity) => void;
  private rejectReady!: (error: Error) => void;
  private sessionId = "";
  private nextId = 0;
  private closed = false;
  private sequence = 0;
  private previewSequence = 0;
  private previewListeners = new Set<(event: PreviewEvent) => void>();
  private pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  private listeners = new Set<(event: ServiceEvent) => void>();
  private failures = new Set<(error: Error) => void>();
  onFailure(listener: (error: Error) => void) {
    this.failures.add(listener);
    return () => {
      this.failures.delete(listener);
    };
  }
  private startupTimer: ReturnType<typeof setTimeout>;
  constructor(private transport: MessageTransport) {
    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    // Attach a rejection handler even if boot fails before callers await ready.
    void this.ready.catch(() => {});
    this.transport.addEventListener("message", this.message);
    this.startupTimer = setTimeout(
      () => this.fail(new VaultError("IO", "编辑服务启动超时。")),
      30000,
    );
  }
  private message = (event: MessageEvent<WorkerMessage>) => {
    const message = event.data;
    if (!message || this.closed) return;
    if (message.kind === "ready") {
      clearTimeout(this.startupTimer);
      this.sessionId = message.sessionId;
      this.resolveReady(message.identity);
    } else if (message.kind === "fatal") this.fail(decodeError(message.error));
    else if (message.kind === "reply") {
      const request = this.pending.get(message.requestId);
      if (!request) return;
      this.pending.delete(message.requestId);
      if (message.error) request.reject(decodeError(message.error));
      else request.resolve(message.result);
    } else if (message.kind === "preview") {
      if (message.event.sequence !== this.previewSequence + 1) {
        this.fail(
          new VaultError("IO", "预览服务通知不连续，请重新打开工作区。"),
        );
        return;
      }
      this.previewSequence = message.event.sequence;
      for (const listener of this.previewListeners) listener(message.event);
    } else if (
      message.kind === "members" ||
      message.kind === "document" ||
      message.kind === "tree" ||
      message.kind === "connection"
    ) {
      if (message.sequence !== this.sequence + 1) {
        this.fail(
          new VaultError("IO", "编辑服务通知不连续，请重新打开工作区。"),
        );
        return;
      }
      this.sequence = message.sequence;
      for (const listener of this.listeners) listener(message);
    }
  };
  async request<M extends keyof ServiceMethods>(
    method: M,
    params: ServiceMethods[M]["params"],
  ): Promise<ServiceMethods[M]["result"]> {
    await this.ready;
    if (this.closed) throw new VaultError("Closed", "编辑服务已关闭。");
    const requestId = ++this.nextId;
    return new Promise<ServiceMethods[M]["result"]>((resolve, reject) => {
      this.pending.set(requestId, {
        resolve: (value) => resolve(value as ServiceMethods[M]["result"]),
        reject,
      });
      try {
        this.transport.postMessage({
          kind: "request",
          requestId,
          sessionId: this.sessionId,
          method,
          params,
        });
      } catch (error) {
        this.pending.delete(requestId);
        reject(error);
      }
    });
  }
  subscribe(listener: (event: ServiceEvent) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  subscribePreview(listener: (event: PreviewEvent) => void) {
    this.previewListeners.add(listener);
    return () => {
      this.previewListeners.delete(listener);
    };
  }
  fail(error: Error) {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.startupTimer);
    this.rejectReady(error);
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
    for (const listener of this.failures) listener(error);
    this.failures.clear();
    this.transport.removeEventListener("message", this.message);
    this.listeners.clear();
    this.previewListeners.clear();
  }
  dispose() {
    this.fail(new VaultError("Closed", "编辑服务已关闭。"));
  }
}
