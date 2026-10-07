import { VaultError } from "../../vault/errors";
import type { SyncPacket, Version } from "../contract";

export function containsVersion(current: Version, checkpoint: Version) {
  return (
    current.identity.document_id === checkpoint.identity.document_id &&
    current.identity.history_id === checkpoint.identity.history_id &&
    Object.entries(checkpoint.clocks).every(
      ([writer, clock]) => clock >= 0 && (current.clocks[writer] ?? 0) >= clock,
    )
  );
}
interface Outgoing {
  id: string;
  packet: SyncPacket;
  version: Version;
  operation: number;
}
interface Waiter {
  id: string;
  version: Version;
  resolve: () => void;
  reject: (error: unknown) => void;
}

/** Host confirmation runs independently of the serialized local editor. */
export class SyncSession {
  private queue: Outgoing[] = [];
  private confirmed = new Map<string, Version>();
  private waiters = new Set<Waiter>();
  private operation = 0;
  private bytes = 0;
  private sending = false;
  private failure: unknown;
  private closed = false;
  constructor(
    private request: (
      update: Outgoing,
    ) => Promise<{ operation: number; version: Version }>,
    private changed: (unconfirmed: boolean) => void,
    private failed: (error: unknown) => void,
    private limits = { operations: 256, bytes: 16 * 1024 * 1024 },
  ) {}
  get unconfirmed() {
    return this.queue.length > 0;
  }
  enqueue(id: string, packet: SyncPacket, version: Version) {
    if (this.closed)
      throw this.failure ?? new VaultError("Closed", "协作会话已关闭。");
    this.queue.push({ id, packet, version, operation: ++this.operation });
    this.bytes += packet.data.length;
    this.changed(true);
    if (
      this.queue.length > this.limits.operations ||
      this.bytes > this.limits.bytes
    ) {
      this.stop(new VaultError("IO", "协作发送队列已满，未确认正文仍保留。"));
      return;
    }
    void this.pump();
  }
  acknowledge(id: string, version: Version) {
    const previous = this.confirmed.get(id);
    if (!previous || containsVersion(version, previous))
      this.confirmed.set(id, version);
    for (const waiter of this.waiters) {
      if (waiter.id === id && containsVersion(version, waiter.version)) {
        this.waiters.delete(waiter);
        waiter.resolve();
      }
    }
  }
  wait(id: string, version: Version): Promise<void> {
    if (this.closed)
      return Promise.reject(
        this.failure ?? new VaultError("Closed", "协作会话已关闭。"),
      );
    const confirmed = this.confirmed.get(id);
    if (confirmed && containsVersion(confirmed, version))
      return Promise.resolve();
    return new Promise((resolve, reject) =>
      this.waiters.add({ id, version, resolve, reject }),
    );
  }
  async drain() {
    // Waiting for every queued checkpoint also covers acknowledgement processing,
    // even if a pushed host snapshot already includes one of these operations.
    while (this.queue.length) {
      if (this.closed)
        throw this.failure ?? new VaultError("Closed", "协作会话已关闭。");
      const last = this.queue[this.queue.length - 1];
      await new Promise<void>((resolve, reject) => {
        this.drains.add({ operation: last.operation, resolve, reject });
      });
    }
  }
  private drains = new Set<{
    operation: number;
    resolve: () => void;
    reject: (error: unknown) => void;
  }>();
  private async pump() {
    if (this.sending || this.closed) return;
    this.sending = true;
    try {
      while (!this.closed && this.queue.length) {
        const update = this.queue[0];
        const reply = await this.request(update);
        if (this.closed) return;
        if (
          reply.operation !== update.operation ||
          !containsVersion(reply.version, update.version)
        )
          throw new VaultError("IO", "协作回执与已发送操作不匹配。");
        this.queue.shift();
        this.bytes -= update.packet.data.length;
        this.acknowledge(update.id, reply.version);
        for (const waiter of this.drains)
          if (waiter.operation <= update.operation) {
            this.drains.delete(waiter);
            waiter.resolve();
          }
        this.changed(this.unconfirmed);
      }
    } catch (error) {
      this.stop(error);
    } finally {
      this.sending = false;
    }
  }
  stop(error: unknown, notify = true) {
    if (this.closed) return;
    this.closed = true;
    this.failure = error;
    for (const waiter of this.waiters) waiter.reject(error);
    for (const waiter of this.drains) waiter.reject(error);
    this.waiters.clear();
    this.drains.clear();
    if (notify) this.failed(error);
  }
}
