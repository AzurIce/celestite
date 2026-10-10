import { VaultError } from "../../vault/errors";
import { decodeError } from "../rpc";
import type { RpcError } from "../contract";
import type { HostDocument, CollaborationSnapshot } from "../contract";
import type { HistoryPacket, Version } from "../contract";

export interface RemoteReceipt {
  kind: "document";
  sequence: number;
  document: Omit<HostDocument, "savedContent"> & { savedContent?: string };
  packet: HistoryPacket;
  peerId: string;
}

/** v3 spelling compatibility exists only at this network boundary. */
function canonicalField(
  object: Record<string, unknown>,
  canonical: string,
  legacy: string,
  equal: (a: unknown, b: unknown) => boolean = Object.is,
) {
  if (
    Object.prototype.hasOwnProperty.call(object, canonical) &&
    Object.prototype.hasOwnProperty.call(object, legacy) &&
    !equal(object[canonical], object[legacy])
  )
    throw new VaultError(
      "IO",
      `Protocol error: conflicting ${canonical}/${legacy}`,
    );
  const value = Object.prototype.hasOwnProperty.call(object, canonical)
    ? object[canonical]
    : object[legacy];
  delete object[legacy];
  object[canonical] = value;
}

function equalVersion(a: unknown, b: unknown): boolean {
  if (a === null || b === null) return a === b;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  const left = a as Version;
  const right = b as Version;
  return (
    left.identity?.document_id === right.identity?.document_id &&
    left.identity?.history_id === right.identity?.history_id &&
    !!left.clocks &&
    !!right.clocks &&
    Object.keys(left.clocks).length === Object.keys(right.clocks).length &&
    Object.entries(left.clocks).every(
      ([peer, clock]) =>
        Object.prototype.hasOwnProperty.call(right.clocks, peer) &&
        right.clocks[peer] === clock,
    )
  );
}

export function normalizeRemoteReceipt(value: unknown): RemoteReceipt {
  if (!value || typeof value !== "object")
    throw new VaultError("IO", "Protocol error: invalid document receipt");
  const receipt = { ...value } as Record<string, unknown>;
  canonicalField(receipt, "peerId", "writerId");
  if (
    typeof receipt.peerId !== "string" ||
    receipt.peerId.length > 20 ||
    !/^(0|[1-9][0-9]*)$/.test(receipt.peerId) ||
    BigInt(receipt.peerId) > 18446744073709551615n
  )
    throw new VaultError("IO", "Protocol error: invalid peerId");
  if (!receipt.document || typeof receipt.document !== "object")
    throw new VaultError("IO", "Protocol error: invalid document metadata");
  const document = { ...receipt.document } as Record<string, unknown>;
  canonicalField(document, "persistedVersion", "durableVersion", equalVersion);
  canonicalField(document, "fileRevision", "backendRevision");
  receipt.document = document;
  return receipt as unknown as RemoteReceipt;
}

function normalizeRemoteResult(value: unknown): unknown {
  if (
    value &&
    typeof value === "object" &&
    "kind" in value &&
    value.kind === "document"
  )
    return normalizeRemoteReceipt(value);
  return value;
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
          this.receive(normalizeRemoteReceipt(frame));
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
          const result = frame.error
            ? undefined
            : normalizeRemoteResult(frame.result);
          clearTimeout(pending.timer);
          this.pending.delete(frame.requestId);
          this.queuedCharacters -= pending.payload.length;
          this.active.delete(frame.requestId);
          this.pump();
          if (frame.error) pending.reject(decodeError(frame.error as RpcError));
          else pending.resolve(result);
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
