import { test } from "node:test";
import assert from "node:assert/strict";
import { RemoteInbox } from "../../src/lib/editor/remote/inbox";
import type { RemoteReceipt } from "../../src/lib/editor/remote/transport";

// Budgeting only reads document identity and packet bytes.
const receipt = (bytes = 1, id = "a") =>
  ({
    document: { id },
    packet: { data: { length: bytes } },
  }) as RemoteReceipt;

test("receive budget includes composition-held receipts until released", () => {
  const inbox = new RemoteInbox();
  inbox.compose("a");
  const held = Array.from({ length: 256 }, () => receipt());
  for (const item of held) {
    inbox.admit(item);
    assert.equal(inbox.hold(item), true);
  }
  assert.throws(() => inbox.admit(receipt()), /队列已满/);
  assert.deepEqual(inbox.take("a"), held);
  assert.throws(() => inbox.admit(receipt()), /队列已满/);
  inbox.release(held[0]);
  inbox.release(held[0]);
  inbox.admit(receipt());
  assert.throws(() => inbox.admit(receipt()), /队列已满/);
});

test("discarding held receipts frees their byte budget without touching scheduled receipts", () => {
  const inbox = new RemoteInbox();
  inbox.compose("a");
  const held = receipt(32 * 1024 * 1024 - 1);
  const scheduled = receipt();
  inbox.admit(held);
  inbox.hold(held);
  inbox.admit(scheduled);
  assert.throws(() => inbox.admit(receipt()), /队列已满/);
  inbox.discard("a");
  assert.equal(inbox.hold(receipt()), false);
  inbox.admit(receipt(32 * 1024 * 1024 - 1));
  assert.throws(() => inbox.admit(receipt()), /队列已满/);
});

test("late releases belong to the old transport's budget", () => {
  const old = new RemoteInbox();
  const next = new RemoteInbox();
  const stale = receipt();
  old.admit(stale);
  next.admit(receipt(32 * 1024 * 1024));
  old.release(stale);
  next.release(stale);
  assert.throws(() => next.admit(receipt()), /队列已满/);
});

test("startup pushes remain budgeted and drain FIFO including arrivals during import", () => {
  const inbox = new RemoteInbox();
  const first = receipt(32 * 1024 * 1024 - 1);
  const second = receipt();
  inbox.admit(first);
  assert.equal(inbox.holdStartup(first), true);
  assert.equal(inbox.nextStartup(), first);
  inbox.admit(second);
  assert.equal(inbox.holdStartup(second), true);
  assert.throws(() => inbox.admit(receipt()), /队列已满/);
  inbox.release(first);
  assert.equal(inbox.nextStartup(), second);
  inbox.release(second);
  assert.equal(inbox.nextStartup(), undefined);
  assert.equal(inbox.holdStartup(receipt()), false);
});

test("failed startup discards startup and composition receipts together", () => {
  const inbox = new RemoteInbox();
  const startup = receipt();
  const held = receipt();
  inbox.admit(startup);
  inbox.holdStartup(startup);
  inbox.compose("a");
  inbox.admit(held);
  inbox.hold(held);
  inbox.stop();
  assert.equal(inbox.stopped, true);
  assert.equal(inbox.nextStartup(), undefined);
  assert.deepEqual(inbox.take("a"), []);
  inbox.release(startup);
  inbox.release(held);
});

test("connect imports pushes only after every open and the new replica session installation", async () => {
  const { RemoteEditorHost } = await import("../../src/lib/editor/remote/host");
  const original = globalThis.WebSocket;
  let socket!: Socket;
  class Socket {
    static OPEN = 1;
    readyState = 1;
    onmessage?: (event: { data: string }) => void;
    onopen?: () => void;
    onclose?: () => void;
    onerror?: () => void;
    requests: { method: string; id: string; requestId: number }[] = [];
    constructor() {
      socket = this;
    }
    send(data: string) {
      this.requests.push(JSON.parse(data));
    }
    close() {}
    frame(frame: unknown) {
      this.onmessage?.({ data: JSON.stringify(frame) });
    }
  }
  globalThis.WebSocket = Socket as unknown as typeof WebSocket;
  const opened = (id: string) =>
    ({
      ...receipt(1, id),
      kind: "document",
      sequence: 1,
      peerId: "1",
      document: {
        id,
        savedContent: "",
        version: {
          identity: { document_id: id, history_id: "history" },
          clocks: {},
        },
      },
    }) as RemoteReceipt;
  const order: string[] = [];
  const host = Object.assign(Object.create(RemoteEditorHost.prototype), {
    inbox: new RemoteInbox(),
    http: { url: "http://localhost" },
    descriptor: { vaultIdentity: { id: "vault", historyId: "history" } },
    subscriptions: new Set(["a", "b"]),
    views: new Map(),
    offline: true,
    execute: async () => {
      order.push("session");
      return [{ id: "a" }, { id: "b" }];
    },
    clearPatches: () => {},
    document: (state: { id: string }) => state,
    receive: async (item: RemoteReceipt) => {
      order.push("push");
      return { id: item.document.id, content: "latest" };
    },
    scheduleRemote: () => {
      throw new Error("startup must not schedule imports");
    },
  });
  try {
    const connecting = host.connect();
    socket.frame({ kind: "hello", sessionId: "session" });
    socket.frame({ kind: "ready", sessionId: "session" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    socket.frame({
      kind: "reply",
      requestId: socket.requests[0].requestId,
      result: opened("a"),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    socket.frame({ ...opened("a"), sequence: 2 });
    assert.deepEqual(order, []);
    assert.equal(host.offline, true);
    socket.frame({
      kind: "reply",
      requestId: socket.requests[1].requestId,
      result: opened("b"),
    });
    const documents = await connecting;
    assert.deepEqual(order, ["session", "push"]);
    assert.equal(
      documents.find((document: { id: string }) => document.id === "a").content,
      "latest",
    );
  } finally {
    host.stopping = true;
    host.inbox.stop();
    host.transport?.close();
    globalThis.WebSocket = original;
  }
});

test("first failed composition import pauses the real host and never imports remaining packets", async () => {
  const { RemoteEditorHost } = await import("../../src/lib/editor/remote/host");
  const inbox = new RemoteInbox();
  const first = receipt();
  const second = receipt();
  inbox.compose("a");
  for (const item of [first, second]) {
    inbox.admit(item);
    inbox.hold(item);
  }
  const imported: RemoteReceipt[] = [];
  let closed = false;
  let pauseScheduled = false;
  // Exercise the real composition and networkFailure methods, substituting
  // only transport/core IO; no Worker or websocket is needed for this failure.
  const host = Object.assign(Object.create(RemoteEditorHost.prototype), {
    inbox,
    offline: false,
    transport: {
      close: () => {
        closed = true;
      },
    },
    receive: async (item: RemoteReceipt) => {
      imported.push(item);
      throw new Error("import rejected");
    },
    scheduleRemote: () => {
      pauseScheduled = true;
    },
  });
  await assert.rejects(host.composition("a", false), /import rejected/);
  assert.deepEqual(imported, [first]);
  assert.equal(host.offline, true);
  assert.equal(closed, true);
  assert.equal(pauseScheduled, true);
  assert.equal(inbox.stopped, true);
});

test("file writes return the backend revision after remote metadata reopening", async () => {
  const { RemoteEditorHost } = await import("../../src/lib/editor/remote/host");
  const reopened: RemoteReceipt[] = [];
  const opened = receipt();
  const transport = { request: async () => opened };
  const host = Object.assign(Object.create(RemoteEditorHost.prototype), {
    offline: false,
    transport,
    hosts: new Map([["a", { id: "a", path: "a" }]]),
    subscriptions: new Set(["a"]),
    descriptor: { readOnly: false },
    execute: async () => ({ snapshot: { text: "" }, savedContent: "" }),
    receive: async (item: RemoteReceipt) => {
      reopened.push(item);
    },
    http: { writeFile: async () => "revision-2" },
  });
  assert.equal(
    await host.fileOperation("writeFile", {
      path: "a",
      data: new Uint8Array(),
    }),
    "revision-2",
  );
  assert.deepEqual(reopened, [opened]);
});
