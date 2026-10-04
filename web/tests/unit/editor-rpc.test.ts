import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EditorClient,
  encodeError,
  type MessageTransport,
} from "../../src/lib/editor/rpc";
import { VaultError, VaultRenameError } from "../../src/lib/vault/errors";
import type {
  WorkerMessage,
  WorkerRequest,
} from "../../src/lib/editor/contract";
class Transport implements MessageTransport {
  sent: WorkerRequest[] = [];
  listeners = new Set<(event: MessageEvent<WorkerMessage>) => void>();
  postMessage(message: WorkerRequest) {
    this.sent.push(message);
  }
  addEventListener(
    _type: "message",
    listener: (event: MessageEvent<WorkerMessage>) => void,
  ) {
    this.listeners.add(listener);
  }
  removeEventListener(
    _type: "message",
    listener: (event: MessageEvent<WorkerMessage>) => void,
  ) {
    this.listeners.delete(listener);
  }
  emit(data: WorkerMessage) {
    for (const listener of this.listeners)
      listener({ data } as MessageEvent<WorkerMessage>);
  }
  ready() {
    this.emit({
      kind: "ready",
      identity: { vault: { vaultId: "v", historyId: "h" }, instanceId: "i" },
      sessionId: "session",
    });
  }
}
test("request IDs correlate out-of-order replies and attach the negotiated session", async () => {
  const transport = new Transport(),
    client = new EditorClient(transport);
  transport.ready();
  const one = client.request("open", { path: "a.md" as any }),
    two = client.request("open", { path: "b.md" as any });
  await Promise.resolve();
  assert.equal(transport.sent.length, 2);
  assert.equal(transport.sent[0].sessionId, "session");
  transport.emit({
    kind: "reply",
    requestId: transport.sent[1].requestId,
    result: "second",
  });
  transport.emit({
    kind: "reply",
    requestId: transport.sent[0].requestId,
    result: "first",
  });
  assert.equal(await one, "first");
  assert.equal(await two, "second");
  client.dispose();
  assert.equal(transport.listeners.size, 0);
});
test("notification gaps fail the service, reject in-flight requests and notify idle views", async () => {
  const transport = new Transport(),
    client = new EditorClient(transport);
  transport.ready();
  let failed = "";
  client.onFailure((error) => (failed = error.message));
  const pending = client.request("save", { id: "d" });
  await Promise.resolve();
  const rejected = assert.rejects(pending, /通知不连续/);
  transport.emit({ kind: "document", sequence: 2, document: {} as any });
  await rejected;
  assert.match(failed, /通知不连续/);
  await assert.rejects(
    client.request("open", { path: "a.md" as any }),
    /已关闭/,
  );
  assert.equal(transport.listeners.size, 0);
});
test("RPC errors preserve partial rename phase and cleanup failures", async () => {
  const transport = new Transport(),
    client = new EditorClient(transport);
  transport.ready();
  const pending = client.request("file", { method: "rename" });
  await Promise.resolve();
  const error = new VaultRenameError(
    new VaultError("IO", "remove failed"),
    "a",
    "b",
    "remove-source",
    new VaultError("Busy", "cleanup failed"),
  );
  transport.emit({
    kind: "reply",
    requestId: transport.sent[0].requestId,
    error: encodeError(error),
  });
  await assert.rejects(
    pending,
    (caught: unknown) =>
      caught instanceof VaultRenameError &&
      caught.targetComplete &&
      caught.from === "a" &&
      caught.to === "b" &&
      caught.cleanupError?.code === "Busy",
  );
  client.dispose();
});
