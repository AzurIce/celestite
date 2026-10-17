import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeRemoteReceipt,
  RemoteTransport,
  type RemoteReceipt,
} from "../../src/lib/editor/remote/transport";

const version = {
  identity: { document_id: "document", history_id: "history" },
  clocks: { "1": 4, "2": 2 },
};
const canonical = () => ({
  kind: "document",
  sequence: 1,
  peerId: "18446744073709551615",
  document: {
    persistedVersion: version,
    fileRevision: "disk",
  },
  packet: { identity: version.identity, kind: "snapshot", data: [] },
});

test("v4 receipts are accepted without legacy rewriting", () => {
  const wire = canonical();
  const receipt = normalizeRemoteReceipt(wire);
  assert.equal(receipt.peerId, wire.peerId);
  assert.deepEqual(receipt.document.persistedVersion, version);
  assert.equal(receipt.document.fileRevision, "disk");
  assert.equal("writerId" in receipt, false);
  assert.equal("durableVersion" in receipt.document, false);
  assert.equal("backendRevision" in receipt.document, false);
  assert.deepEqual(normalizeRemoteReceipt(receipt), receipt);
});

test("retired v3 spellings do not satisfy v4 fields", () => {
  assert.throws(
    () =>
      normalizeRemoteReceipt({
        ...canonical(),
        peerId: undefined,
        writerId: "1",
      }),
    /invalid peerId/,
  );
});

test("peer IDs use canonical decimal u64 strings", () => {
  for (const peerId of [
    "01",
    "-1",
    "+1",
    "1.0",
    "18446744073709551616",
    "",
    1,
    undefined,
  ])
    assert.throws(
      () => normalizeRemoteReceipt({ ...canonical(), peerId }),
      /invalid peerId/,
    );
  assert.equal(
    normalizeRemoteReceipt({ ...canonical(), peerId: "0" }).peerId,
    "0",
  );
});

test("overlong peer IDs are rejected before BigInt conversion", () => {
  const receipt = normalizeRemoteReceipt(canonical());
  const original = globalThis.BigInt;
  globalThis.BigInt = (() => {
    throw new Error("BigInt must not parse overlong peer IDs");
  }) as unknown as typeof BigInt;
  try {
    for (const peerId of ["184467440737095516150", "9".repeat(100_000)]) {
      assert.throws(
        () => normalizeRemoteReceipt({ ...receipt, peerId }),
        /invalid peerId/,
      );
    }
  } finally {
    globalThis.BigInt = original;
  }
});

test("transport sends the v4 handshake and delivers canonical receipts", async () => {
  const original = globalThis.WebSocket;
  let socket!: Socket;
  class Socket {
    static OPEN = 1;
    readyState = 1;
    onopen?: () => void;
    onmessage?: (event: { data: string }) => void;
    requests: Record<string, unknown>[] = [];
    constructor() {
      socket = this;
    }
    send(data: string) {
      this.requests.push(JSON.parse(data));
    }
    close() {}
    frame(value: unknown) {
      this.onmessage?.({ data: JSON.stringify(value) });
    }
  }
  globalThis.WebSocket = Socket as unknown as typeof WebSocket;
  const received: unknown[] = [];
  const failures: unknown[] = [];
  const transport = new RemoteTransport(
    "http://localhost",
    { vaultId: "vault", historyId: "history" },
    (receipt) => received.push(receipt),
    (error) => failures.push(error),
  );
  try {
    socket.onopen?.();
    assert.deepEqual(socket.requests[0], {
      protocolVersion: 4,
      vault: { vaultId: "vault", historyId: "history" },
    });
    socket.frame({ kind: "hello", sessionId: "session" });
    socket.frame({ kind: "ready", sessionId: "session" });
    await transport.ready;
    socket.frame(canonical());
    assert.deepEqual(received, [normalizeRemoteReceipt(canonical())]);
    const request = transport.request<RemoteReceipt>("open");
    socket.frame({
      kind: "reply",
      requestId: socket.requests[1].requestId,
      result: canonical(),
    });
    assert.deepEqual(await request, normalizeRemoteReceipt(canonical()));
    assert.equal(failures.length, 0);
  } finally {
    transport.close();
    globalThis.WebSocket = original;
  }
});
