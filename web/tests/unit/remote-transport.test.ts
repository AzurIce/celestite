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
const legacy = () => ({
  kind: "document",
  sequence: 1,
  writerId: "18446744073709551615",
  document: { durableVersion: version, backendRevision: "disk" },
  packet: { identity: version.identity, kind: "snapshot", data: [] },
});

test("v3 legacy receipts normalize without leaking legacy fields or mutating input", () => {
  const wire = legacy();
  const receipt = normalizeRemoteReceipt(wire);
  assert.equal(receipt.peerId, wire.writerId);
  assert.deepEqual(receipt.document.persistedVersion, version);
  assert.equal(receipt.document.fileRevision, "disk");
  assert.equal("writerId" in receipt, false);
  assert.equal("durableVersion" in receipt.document, false);
  assert.equal("backendRevision" in receipt.document, false);
  assert.equal("writerId" in wire, true);
});

test("canonical receipts and equivalent dual spellings are accepted structurally", () => {
  const wire = legacy();
  const dual = {
    ...wire,
    peerId: wire.writerId,
    document: {
      ...wire.document,
      persistedVersion: {
        identity: { ...version.identity },
        clocks: { "2": 2, "1": 4 },
      },
      fileRevision: "disk",
    },
  };
  assert.deepEqual(normalizeRemoteReceipt(dual), normalizeRemoteReceipt(wire));
  const canonical = normalizeRemoteReceipt(wire);
  assert.deepEqual(normalizeRemoteReceipt(canonical), canonical);
});

test("conflicting peer, file revision, version clocks or identity are protocol errors", () => {
  assert.throws(
    () => normalizeRemoteReceipt({ ...legacy(), peerId: "2" }),
    /Protocol error/,
  );
  for (const fields of [
    { fileRevision: "other" },
    { persistedVersion: null },
    { persistedVersion: { ...version, clocks: { "1": 5, "2": 2 } } },
    {
      persistedVersion: {
        ...version,
        identity: { ...version.identity, history_id: "other" },
      },
    },
  ])
    assert.throws(
      () =>
        normalizeRemoteReceipt({
          ...legacy(),
          document: { ...legacy().document, ...fields },
        }),
      /Protocol error/,
    );
});

test("peer IDs use canonical decimal u64 strings", () => {
  for (const writerId of [
    "01",
    "-1",
    "+1",
    "1.0",
    "18446744073709551616",
    "",
    1,
  ])
    assert.throws(
      () => normalizeRemoteReceipt({ ...legacy(), writerId }),
      /invalid peerId/,
    );
  assert.equal(
    normalizeRemoteReceipt({ ...legacy(), writerId: "0" }).peerId,
    "0",
  );
});

test("overlong peer IDs are rejected before BigInt conversion", () => {
  const canonical = normalizeRemoteReceipt(legacy());
  const original = globalThis.BigInt;
  globalThis.BigInt = (() => {
    throw new Error("BigInt must not parse overlong peer IDs");
  }) as unknown as typeof BigInt;
  try {
    for (const peerId of ["184467440737095516150", "9".repeat(100_000)]) {
      assert.throws(
        () => normalizeRemoteReceipt({ ...canonical, peerId }),
        /invalid peerId/,
      );
      assert.throws(
        () => normalizeRemoteReceipt({ ...legacy(), writerId: peerId }),
        /invalid peerId/,
      );
    }
  } finally {
    globalThis.BigInt = original;
  }
});

test("transport normalizes pushes and replies and rejects pending requests on conflicts", async () => {
  const original = globalThis.WebSocket;
  let socket!: Socket;
  class Socket {
    static OPEN = 1;
    readyState = 1;
    onmessage?: (event: { data: string }) => void;
    requests: { requestId: number }[] = [];
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
    { id: "vault", historyId: "history" },
    (receipt) => received.push(receipt),
    (error) => failures.push(error),
  );
  try {
    socket.frame({ kind: "hello", sessionId: "session" });
    socket.frame({ kind: "ready", sessionId: "session" });
    await transport.ready;
    socket.frame(legacy());
    assert.deepEqual(received, [normalizeRemoteReceipt(legacy())]);
    const request = transport.request<RemoteReceipt>("open");
    socket.frame({
      kind: "reply",
      requestId: socket.requests[0].requestId,
      result: legacy(),
    });
    assert.deepEqual(await request, normalizeRemoteReceipt(legacy()));
    const conflicting = transport.request("save");
    const rejected = assert.rejects(conflicting, /Protocol error/);
    socket.frame({
      kind: "reply",
      requestId: socket.requests[1].requestId,
      result: { ...legacy(), peerId: "2" },
    });
    await rejected;
    assert.equal(failures.length, 1);
    assert.equal(received.length, 1);
  } finally {
    transport.close();
    globalThis.WebSocket = original;
  }
});
