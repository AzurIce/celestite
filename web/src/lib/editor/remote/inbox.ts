import { VaultError } from "../../vault/errors";
import type { RemoteReceipt } from "./transport";

/** One transport's receive budget, including receipts held during composition. */
export class RemoteInbox {
  private pending = new Set<RemoteReceipt>();
  private bytes = 0;
  private composing = new Set<string>();
  private held = new Map<string, RemoteReceipt[]>();
  private startup: RemoteReceipt[] | null = [];
  stopped = false;

  holdStartup(receipt: RemoteReceipt) {
    if (!this.startup) return false;
    this.startup.push(receipt);
    return true;
  }

  nextStartup() {
    const receipt = this.startup?.shift();
    if (!receipt) this.startup = null;
    return receipt;
  }

  stop() {
    this.stopped = true;
    this.startup = null;
    this.held.clear();
    this.composing.clear();
    this.pending.clear();
    this.bytes = 0;
  }

  admit(receipt: RemoteReceipt) {
    if (this.stopped) throw new VaultError("Closed", "协作会话已替换。");
    if (
      this.pending.size >= 256 ||
      this.bytes + receipt.packet.data.length > 32 * 1024 * 1024
    )
      throw new VaultError("IO", "协作接收队列已满，正文仍保留。");
    this.pending.add(receipt);
    this.bytes += receipt.packet.data.length;
  }

  release(receipt: RemoteReceipt) {
    if (this.pending.delete(receipt)) this.bytes -= receipt.packet.data.length;
  }

  hold(receipt: RemoteReceipt) {
    const id = receipt.document.id;
    if (!this.composing.has(id)) return false;
    const receipts = this.held.get(id) ?? [];
    receipts.push(receipt);
    this.held.set(id, receipts);
    return true;
  }

  compose(id: string) {
    this.composing.add(id);
  }

  take(id: string) {
    this.composing.delete(id);
    const receipts = this.held.get(id) ?? [];
    this.held.delete(id);
    return receipts;
  }

  discard(id: string) {
    for (const receipt of this.take(id)) this.release(receipt);
  }
}
