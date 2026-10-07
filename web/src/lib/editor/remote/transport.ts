import { VaultError } from "../../vault/errors";
import { decodeError } from "../rpc";
import type { RpcError } from "../contract";
import type { HostDocument, CollaborationSnapshot } from "../contract";
import type { SyncPacket } from "../contract";

export interface RemoteReceipt {
  kind: "document";
  sequence: number;
  document: Omit<HostDocument, "savedContent"> & { savedContent?: string };
  packet: SyncPacket;
  writerId: string;
}
/** Network replies resolve outside the core queue. Push imports are scheduled
 * by the host, so a request awaiting its acknowledgement cannot deadlock. */
export class RemoteTransport {
  private socket: WebSocket;
  private sessionId = "";
  private nextRequest = 0;
  private pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: unknown) => void;
      payload: string;
      timer?: ReturnType<typeof setTimeout>;
    }
  >();
  private active = new Set<number>();
  private queuedCharacters = 0;
  private closed = false;
  private initialized = false;
  private readyResolve!: () => void;
  private readyReject!: (error: unknown) => void;
  readonly ready = new Promise<void>((resolve, reject) => {
    this.readyResolve = resolve;
    this.readyReject = reject;
  });
  private heartbeat: ReturnType<typeof setInterval>;
  private lastMessage = Date.now();
  constructor(
    url: string,
    identity: { id: string; historyId: string },
    private receive: (
      receipt:
        | RemoteReceipt
        | { kind: "tree" }
        | { kind: "members"; state: CollaborationSnapshot },
    ) => void,
    private disconnected: (error: unknown) => void,
  ) {
    const address = new URL(url + "/api/v1/sync");
    address.protocol = address.protocol === "https:" ? "wss:" : "ws:";
    this.socket = new WebSocket(address);
    this.socket.onopen = () =>
      this.socket.send(
        JSON.stringify({ protocolVersion: 3, vaultIdentity: identity }),
      );
    this.socket.onmessage = (event) => {
      if (this.closed) return;
      try {
        this.lastMessage = Date.now();
        const frame = JSON.parse(String(event.data));
        if (frame.kind === "hello") this.sessionId = frame.sessionId;
        else if (frame.kind === "document") {
          if (!this.initialized)
            throw new Error("Buffer received before session readiness");
          this.receive(frame);
        } else if (frame.kind === "members")
          this.receive({
            kind: "members",
            state: { ...frame.state, sessionId: this.sessionId },
          });
        else if (frame.kind === "tree") this.receive(frame);
        else if (frame.kind === "ready") {
          if (!this.sessionId || frame.sessionId !== this.sessionId)
            throw new Error("Invalid session barrier");
          this.initialized = true;
          this.readyResolve();
        } else if (frame.kind === "reply") {
          const pending = this.pending.get(frame.requestId);
          if (!pending) return;
          clearTimeout(pending.timer);
          this.pending.delete(frame.requestId);
          this.queuedCharacters -= pending.payload.length;
          this.active.delete(frame.requestId);
          this.pump();
          if (frame.error) pending.reject(decodeError(frame.error as RpcError));
          else pending.resolve(frame.result);
        } else if (frame.kind === "fatal") this.fail(decodeError(frame));
      } catch (error) {
        this.fail(error);
      }
    };
    this.socket.onclose = () =>
      this.fail(new VaultError("IO", "远端连接中断，编辑正文仍保留。"));
    this.socket.onerror = () =>
      this.fail(new VaultError("IO", "无法连接远端协作会话。"));
    this.heartbeat = setInterval(() => {
      if (Date.now() - this.lastMessage > 30000)
        this.fail(new VaultError("IO", "远端协作会话超时。"));
      else if (this.initialized)
        void this.request("ping").catch((error) => this.fail(error));
    }, 10000);
  }
  request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (
      this.closed ||
      !this.initialized ||
      this.socket.readyState !== WebSocket.OPEN
    )
      return Promise.reject(new VaultError("Closed", "协作会话未连接。"));
    const requestId = ++this.nextRequest;
    const payload = JSON.stringify({
      ...params,
      method,
      requestId,
      sessionId: this.sessionId,
    });
    if (
      this.pending.size >= 64 ||
      this.queuedCharacters + payload.length > 80 * 1024 * 1024
    ) {
      const error = new VaultError("IO", "协作请求队列已满，正文仍保留。");
      this.fail(error);
      return Promise.reject(error);
    }
    return new Promise<T>((resolve, reject) => {
      this.pending.set(requestId, {
        resolve: resolve as (value: unknown) => void,
        reject,
        payload,
      });
      this.queuedCharacters += payload.length;
      this.pump();
    });
  }
  private pump() {
    if (this.closed) return;
    for (const [requestId, pending] of this.pending) {
      if (this.active.size >= 2) break;
      if (pending.timer !== undefined) continue;
      this.active.add(requestId);
      pending.timer = setTimeout(
        () => this.fail(new VaultError("IO", "协作操作确认超时；正文仍保留。")),
        20000,
      );
      try {
        this.socket.send(pending.payload);
      } catch (error) {
        this.fail(error);
        break;
      }
    }
  }
  private fail(error: unknown) {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.heartbeat);
    this.readyReject(error);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.socket.close();
    this.disconnected(error);
  }
  close() {
    if (this.closed) return;
    this.fail(new VaultError("Closed", "协作会话已关闭。"));
  }
}
