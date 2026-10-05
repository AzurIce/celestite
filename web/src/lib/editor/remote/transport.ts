import { VaultError } from "../../vault/errors";
import { decodeError } from "../rpc";
import type { RpcError } from "../contract";
import type { CoreDocument } from "../runtime/host";
import type { SyncPacket } from "../contract";

export interface RemoteReceipt {
  kind: "document";
  sequence: number;
  document: Omit<CoreDocument, "savedContent" | "snapshot"> & {
    savedContent?: string;
    snapshot: Omit<CoreDocument["snapshot"], "text">;
  };
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
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private closed = false;
  private initialized = false;
  private initial: RemoteReceipt[] = [];
  private readyResolve!: (receipts: RemoteReceipt[]) => void;
  private readyReject!: (error: unknown) => void;
  readonly ready = new Promise<RemoteReceipt[]>((resolve, reject) => {
    this.readyResolve = resolve;
    this.readyReject = reject;
  });
  private heartbeat: ReturnType<typeof setInterval>;
  private lastMessage = Date.now();
  constructor(
    url: string,
    token: string,
    identity: { id: string; historyId: string },
    private receive: (receipt: RemoteReceipt | { kind: "tree" }) => void,
    private disconnected: (error: unknown) => void,
  ) {
    const address = new URL(url + "/sync");
    address.protocol = address.protocol === "https:" ? "wss:" : "ws:";
    this.socket = new WebSocket(address);
    this.socket.onopen = () =>
      this.socket.send(
        JSON.stringify({ protocolVersion: 1, token, vaultIdentity: identity }),
      );
    this.socket.onmessage = (event) => {
      if (this.closed) return;
      try {
        this.lastMessage = Date.now();
        const frame = JSON.parse(String(event.data));
        if (frame.kind === "hello") this.sessionId = frame.sessionId;
        else if (frame.kind === "document") {
          if (!this.initialized) this.initial.push(frame);
          else this.receive(frame);
        } else if (frame.kind === "tree") this.receive(frame);
        else if (frame.kind === "ready") {
          if (!this.sessionId || frame.sessionId !== this.sessionId)
            throw new Error("Invalid session barrier");
          this.initialized = true;
          this.readyResolve(this.initial);
          this.initial = [];
        } else if (frame.kind === "reply") {
          const pending = this.pending.get(frame.requestId);
          if (!pending) return;
          clearTimeout(pending.timer);
          this.pending.delete(frame.requestId);
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
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => this.fail(new VaultError("IO", "协作操作确认超时；正文仍保留。")),
        20000,
      );
      this.pending.set(requestId, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
      this.socket.send(
        JSON.stringify({
          ...params,
          method,
          requestId,
          sessionId: this.sessionId,
        }),
      );
    });
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
