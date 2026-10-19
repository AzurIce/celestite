import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BufferBinding,
  EditorBinding,
  PreviewBinding,
} from "../../src/lib/editor/generated/celestite_core";
import { coreReady } from "./core-runtime";
import {
  coreValue,
  wasmCore,
  type CoreDocument,
  type CorePort,
} from "../../src/lib/editor/core";
import { RemoteEditorSession } from "../../src/lib/editor/remote/editor-session";
import { SyncSession } from "../../src/lib/editor/remote/session";
import type { RemoteReceipt } from "../../src/lib/editor/remote/transport";
import type {
  ServiceEvent,
  ServiceMessage,
  ServiceRequest,
} from "../../src/lib/editor/contract";
import { serveEditor } from "../../src/lib/editor/runtime/service";
import { EditorClient } from "../../src/lib/editor/rpc";
import { ClientDocuments } from "../../src/lib/editor/client/documents";
import { PreviewResources } from "../../src/lib/preview/resources";
import type {
  HttpVaultBackend,
  RemoteVaultDescriptor,
} from "../../src/lib/vault/http";
import { VaultError } from "../../src/lib/vault/errors";
import { vaultPath } from "../../src/lib/vault/path";

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function replica() {
  await coreReady;
  const identity = {
    document_id: crypto.randomUUID(),
    history_id: crypto.randomUUID(),
  };
  const seed = new BufferBinding(JSON.stringify(identity), "1", "host");
  const descriptor = {
    vault: { vaultId: "vault", historyId: "history" },
    readOnly: false,
  } as RemoteVaultDescriptor;
  const binding = await EditorBinding.memory(
    JSON.stringify({
      instanceId: crypto.randomUUID(),
      vault: descriptor.vault,
    }),
  );
  const wasm = wasmCore(binding);
  const initial = coreValue<CoreDocument>(
    await wasm.call("join", {
      path: "a.md",
      packet: JSON.parse(seed.export_snapshot()),
    }),
  );
  const edited = await wasm.call("apply", {
    id: initial.id,
    command: {
      kind: "edit",
      base: initial.version,
      input: { kind: "edits", edits: [{ from: 4, to: 4, insert: " UNSENT" }] },
      undo: { positions: [] },
    },
  });
  coreValue(edited);
  const old = coreValue<CoreDocument>(
    await wasm.call("read", { id: initial.id }),
  );
  const receipt: RemoteReceipt = {
    kind: "document",
    sequence: 1,
    peerId: "2",
    document: {
      id: initial.id,
      path: vaultPath("a.md"),
      version: initial.version,
      savedContent: "host",
      savedVersion: initial.version,
      recoveryError: null,
      dirty: false,
      fileRevision: "disk",
      bom: false,
      lineEnding: "\n",
      deleted: false,
      conflict: false,
      error: null,
      externalChange: null,
    },
    packet: JSON.parse(seed.export_snapshot()),
  };
  const events: ServiceEvent[] = [];
  let emit: ((event: ServiceEvent) => void) | undefined;
  let schedule: ((task: () => Promise<unknown>) => void) | undefined;
  let call: CorePort["call"] = (method, params) => wasm.call(method, params);
  const host = new RemoteEditorSession(
    { call: (method, params) => call(method, params) },
    {
      url: "http://localhost",
      describe: async () => descriptor,
    } as HttpVaultBackend,
    descriptor,
    (event) => {
      events.push(event);
      emit?.(event);
    },
    (task) => {
      if (schedule) schedule(task);
      else void task().catch(() => {});
    },
  );
  const state = host as any;
  state.subscriptions.add(initial.id);
  state.hosts.set(initial.id, receipt.document);
  state.views.set("view", {
    viewId: "view",
    documentId: initial.id,
    focused: true,
    selection: null,
  });
  const sync = new SyncSession(
    () => new Promise(() => {}),
    () => {},
    () => {},
  );
  sync.enqueue(initial.id, edited.mutations[0].update.operation!, old.version);
  sync.stop(new VaultError("IO", "old transport lost"), false);
  state.sync = sync;
  const original = globalThis.WebSocket;
  let socket!: Socket;
  let request = async (
    method: string,
    _params?: Record<string, unknown>,
  ): Promise<unknown> => {
    if (method === "open") return receipt;
    if (method === "set_view") return null;
    throw new Error(`Unexpected request ${method}`);
  };
  class Socket {
    static OPEN = 1;
    readyState = 1;
    onmessage?: (event: { data: string }) => void;
    onclose?: () => void;
    constructor() {
      socket = this;
      queueMicrotask(() => {
        this.frame({ kind: "hello", sessionId: "session" });
        this.frame({ kind: "ready", sessionId: "session" });
      });
    }
    send(data: string) {
      const message = JSON.parse(data);
      void request(message.method, message).then(
        (result) =>
          this.frame({ kind: "reply", requestId: message.requestId, result }),
        (error) =>
          this.frame({
            kind: "reply",
            requestId: message.requestId,
            error: { code: error.code ?? "IO", message: error.message },
          }),
      );
    }
    frame(value: unknown) {
      this.onmessage?.({ data: JSON.stringify(value) });
    }
    close() {}
    drop() {
      this.onclose?.();
    }
  }
  globalThis.WebSocket = Socket as unknown as typeof WebSocket;
  return {
    setEmitter(next: typeof emit) {
      emit = next;
    },
    setScheduler(next: typeof schedule) {
      schedule = next;
    },
    host,
    state,
    wasm,
    old,
    receipt,
    events,
    sync,
    socket: () => socket,
    request: (next: typeof request) => {
      request = next;
    },
    intercept: (next: typeof call) => {
      call = next;
    },
    async assertUnchanged() {
      const after = coreValue<CoreDocument>(
        await wasm.call("read", { id: initial.id }),
      );
      assert.equal(after.snapshot.text, old.snapshot.text);
      assert.equal(after.peerId, old.peerId);
      assert.deepEqual(after.undo, old.undo);
      assert.equal(state.sync, sync);
      assert.equal(state.unconfirmed, true);
      await assert.rejects(host.flush(), /未确认/);
    },
    dispose() {
      host.dispose();
      binding.free();
      seed.free();
      globalThis.WebSocket = original;
    },
  };
}
async function rpcReplica(f: Awaited<ReturnType<typeof replica>>) {
  let receive!: (event: MessageEvent<ServiceRequest>) => void;
  let listener!: (event: MessageEvent<ServiceMessage>) => void;
  let deliver = (message: ServiceMessage) =>
    queueMicrotask(() =>
      listener({ data: message } as MessageEvent<ServiceMessage>),
    );
  const client = new EditorClient({
    postMessage: (data) =>
      queueMicrotask(() => receive({ data } as MessageEvent<ServiceRequest>)),
    addEventListener: (_, next) => {
      listener = next;
    },
    removeEventListener() {},
  });
  if (f.state.offline) {
    f.state.offline = false;
    f.state.transport = { request: async () => f.receipt, close() {} };
  }
  let detach!: () => void;
  const lifetime = serveEditor(
    {
      postMessage: (message) => deliver(message),
      addEventListener: (_, next) => {
        receive = next;
      },
    },
    async (emit, schedule) => {
      f.setEmitter(emit);
      f.setScheduler(schedule);
      return {
        identity: {
          instanceId: "instance",
          vault: { vaultId: "vault", historyId: "history" },
        },
        host: f.host,
        previewBinding: new PreviewBinding(),
        previewResources: new PreviewResources({} as HttpVaultBackend),
        dispose() {},
      };
    },
    (next) => {
      detach = next;
    },
  );
  await client.ready;
  const documents = new ClientDocuments(client, () => {}, true);
  assert.equal(await documents.open(vaultPath("a.md")), true);
  return {
    documents,
    delivery(
      next: (
        message: ServiceMessage,
        forward: (message: ServiceMessage) => void,
      ) => void,
    ) {
      const forward = deliver;
      deliver = (message) => next(message, forward);
    },
    async dispose() {
      client.dispose();
      detach();
      await lifetime;
    },
  };
}
function push(
  f: Awaited<ReturnType<typeof replica>>,
  remote: BufferBinding,
  insert: string,
  sequence: number,
) {
  const before = JSON.parse(remote.snapshot());
  remote.apply(
    JSON.stringify({
      kind: "edit",
      base: before.version,
      input: {
        kind: "edits",
        edits: [{ from: before.text.length, to: before.text.length, insert }],
      },
      undo: { positions: [] },
    }),
  );
  f.socket().frame({
    ...f.receipt,
    sequence,
    document: {
      ...f.receipt.document,
      dirty: true,
      version: JSON.parse(remote.snapshot()).version,
    },
    packet: JSON.parse(
      remote.export_updates_since(JSON.stringify(before.version)),
    ),
  });
}
async function until(check: () => boolean | Promise<boolean>) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await check()) return;
    await tick();
  }
  assert.fail("remote update did not settle");
}

for (const failingMethod of ["open", "set_view"]) {
  test(`failed reconnect ${failingMethod} preserves text, peer undo and unconfirmed flush barrier`, async () => {
    const f = await replica();
    f.request(async (method) => {
      if (method === failingMethod)
        throw new VaultError("IO", `${method} failed`);
      return f.receipt;
    });
    try {
      await assert.rejects(
        f.host.reconnect(),
        new RegExp(`${failingMethod} failed`),
      );
      await f.assertUnchanged();
    } finally {
      f.dispose();
    }
  });
}
test("invalid startup push is validated atomically with replacement snapshots", async () => {
  const f = await replica();
  f.request(async (method) => {
    if (method === "set_view") {
      f.socket().frame({
        ...f.receipt,
        sequence: 2,
        packet: { ...f.receipt.packet, data: [255] },
      });
      return null;
    }
    return f.receipt;
  });
  try {
    await assert.rejects(f.host.reconnect());
    await f.assertUnchanged();
  } finally {
    f.dispose();
  }
});
test("replacement queued behind another core lease cannot commit after transport failure", async () => {
  const f = await replica();
  const entered = deferred(),
    release = deferred();
  let replacements = 0;
  f.intercept(async (method, params) => {
    if (method === "replica_session") replacements++;
    return f.wasm.call(method, params);
  });
  const capture = f.host.withSource([f.old.id], async () => {
    entered.resolve();
    await release.promise;
  });
  try {
    await entered.promise;
    const reconnect = f.host.reconnect();
    await tick();
    f.socket().drop();
    release.resolve();
    await capture;
    await assert.rejects(reconnect);
    assert.equal(replacements, 0);
    await f.assertUnchanged();
  } finally {
    release.resolve();
    f.dispose();
  }
});
test("successful core replacement remains committed when its reply arrives after disconnect", async () => {
  const f = await replica();
  const committed = deferred(),
    release = deferred();
  f.intercept(async (method, params) => {
    const reply = await f.wasm.call(method, params);
    if (method === "replica_session") {
      committed.resolve();
      await release.promise;
    }
    return reply;
  });
  try {
    const reconnect = f.host.reconnect();
    await committed.promise;
    f.socket().drop();
    release.resolve();
    const { documents } = await reconnect;
    assert.equal(documents[0].content, "host");
    assert.equal(documents[0].core!.peerId, "2");
    assert.equal(documents[0].core!.undo.canUndo, false);
    assert.match(documents[0].readOnlyReason!, /中断/);
    assert.notEqual(f.state.sync, f.sync);
    assert.equal(f.state.offline, true);
    assert.deepEqual(
      f.state.hosts.get(f.old.id).version,
      f.receipt.document.version,
    );
    assert.equal(
      f.events.some(
        (event) =>
          event.kind === "connection" && event.connection.status === "online",
      ),
      false,
    );
    assert.equal(
      f.events.some(
        (event) =>
          event.kind === "connection" && event.connection.status === "offline",
      ),
      true,
    );
  } finally {
    release.resolve();
    f.dispose();
  }
});
test("failed private join unsubscribes the real host id and exposes its actual error", async () => {
  const calls: string[] = [];
  const receipt = {
    kind: "document",
    sequence: 1,
    peerId: "1",
    document: { id: "host-doc", path: "a.md", savedContent: "valid UTF-8" },
    packet: { data: [] },
  };
  const host = new RemoteEditorSession(
    {
      async call(method) {
        assert.equal(method, "replica_join");
        return {
          status: "error",
          mutations: [],
          error: {
            code: "Unsupported",
            message: "CRDT snapshot exceeds 16 MiB",
            path: "a.md",
          },
        };
      },
    },
    {} as HttpVaultBackend,
    { readOnly: false } as RemoteVaultDescriptor,
    () => {},
    () => {},
  );
  const state = host as any;
  state.offline = false;
  state.transport = {
    async request(method: string, params: Record<string, unknown>) {
      calls.push(method);
      if (method === "open") return receipt;
      assert.equal(method, "unsubscribe");
      assert.equal(params.id, "host-doc");
    },
    close() {},
  };
  try {
    await assert.rejects(
      host.open(vaultPath("a.md")),
      /CRDT snapshot exceeds 16 MiB/,
    );
    assert.deepEqual(calls, ["open", "unsubscribe"]);
    assert.equal(state.subscriptions.size, 0);
    assert.equal(state.unsupported.size, 0);
    assert.equal(state.offline, false);
  } finally {
    host.dispose();
  }
});
test("host Unsupported file response remains a downloadable placeholder without a subscription", async () => {
  const host = new RemoteEditorSession(
    {
      async call() {
        throw new Error("unexpected core call");
      },
    },
    {} as HttpVaultBackend,
    { readOnly: false } as RemoteVaultDescriptor,
    () => {},
    () => {},
  );
  const state = host as any;
  state.offline = false;
  state.transport = {
    async request() {
      throw new VaultError("Unsupported", "File exceeds the read limit");
    },
    close() {},
  };
  try {
    const document = await host.open(vaultPath("large.md"));
    assert.match(document.readOnlyReason!, /5 MiB/);
    assert.equal(state.subscriptions.size, 0);
  } finally {
    host.dispose();
  }
});

test("views changed while core replacement awaits are reconciled after the commit", async () => {
  const f = await replica();
  const committed = deferred(),
    release = deferred();
  const views: Record<string, unknown>[] = [];
  f.request(async (method, params) => {
    if (method === "set_view") {
      views.push(params!);
      return null;
    }
    return f.receipt;
  });
  f.intercept(async (method, params) => {
    const reply = await f.wasm.call(method, params);
    if (method === "replica_session") {
      committed.resolve();
      await release.promise;
    }
    return reply;
  });
  try {
    const reconnect = f.host.reconnect();
    await committed.promise;
    await assert.rejects(f.host.reconnect(), /正在恢复/);
    await f.host.setView("view", null, false);
    await f.host.setView("replacement-view", f.old.id, true);
    release.resolve();
    const { documents } = await reconnect;
    assert.equal(documents[0].content, "host");
    assert.equal(
      views.some((view) => view.viewId === "view" && view.documentId === null),
      true,
    );
    assert.equal(
      views.some(
        (view) =>
          view.viewId === "replacement-view" && view.documentId === f.old.id,
      ),
      true,
    );
  } finally {
    release.resolve();
    f.dispose();
  }
});
test("view failure after a committed replacement returns the new offline documents", async () => {
  const f = await replica();
  const committed = deferred(),
    release = deferred();
  f.request(async (method, params) => {
    if (method === "set_view" && params?.viewId === "replacement-view")
      throw new VaultError("IO", "late view registration failed");
    return f.receipt;
  });
  f.intercept(async (method, params) => {
    const reply = await f.wasm.call(method, params);
    if (method === "replica_session") {
      committed.resolve();
      await release.promise;
    }
    return reply;
  });
  try {
    const reconnect = f.host.reconnect();
    await committed.promise;
    await f.host.setView("replacement-view", f.old.id, true);
    release.resolve();
    const { documents } = await reconnect;
    assert.equal(documents[0].content, "host");
    assert.match(documents[0].readOnlyReason!, /中断/);
    assert.notEqual(f.state.sync, f.sync);
    assert.equal(f.state.offline, true);
  } finally {
    release.resolve();
    f.dispose();
  }
});

test("unknown core IO after a successful join pauses the connection for session reconstruction", async () => {
  let joined = false,
    closed = false;
  const receipt = {
    kind: "document",
    sequence: 1,
    peerId: "1",
    document: { id: "host-doc", path: "a.md", savedContent: "host" },
    packet: { data: [] },
  };
  const host = new RemoteEditorSession(
    {
      async call(method) {
        if (method === "replica_join") {
          joined = true;
          return { status: "ok", mutations: [], value: null };
        }
        assert.equal(method, "replica_host_state");
        return {
          status: "error",
          mutations: [],
          error: { code: "IO", message: "IPC reply lost", path: "a.md" },
        };
      },
    },
    {} as HttpVaultBackend,
    { readOnly: false } as RemoteVaultDescriptor,
    () => {},
    () => {},
  );
  const state = host as any;
  state.offline = false;
  state.transport = {
    async request(method: string) {
      if (method === "open") return receipt;
    },
    close() {
      closed = true;
    },
  };
  try {
    await assert.rejects(host.open(vaultPath("a.md")), /IPC reply lost/);
    assert.equal(joined, true);
    assert.equal(state.subscriptions.size, 0);
    assert.equal(state.offline, true);
    assert.equal(closed, true);
    await assert.rejects(host.open(vaultPath("other.md")), /中断/);
  } finally {
    host.dispose();
  }
});

test("reconnect coalesces full snapshots and later metadata delivered before the RPC reply", async () => {
  const f = await replica();
  const rpc = await rpcReplica(f);
  const remote = BufferBinding.from_snapshot(
    JSON.stringify(f.receipt.packet),
    "3",
  );
  const captured = deferred(),
    release = deferred();
  rpc.delivery((message, forward) => {
    if (
      message.kind === "reply" &&
      message.result &&
      "documents" in (message.result as object)
    ) {
      captured.resolve();
      void release.promise.then(() => forward(message));
    } else forward(message);
  });
  try {
    const reconnect = rpc.documents.reconnectSession(true);
    await captured.promise;
    push(f, remote, " REMOTE", 2);
    await until(
      async () => (await f.host.read(f.old.id)).content === "host REMOTE",
    );
    push(f, remote, " MORE", 3);
    await until(
      async () => (await f.host.read(f.old.id)).content === "host REMOTE MORE",
    );
    f.socket().frame({
      ...f.receipt,
      sequence: 4,
      document: {
        ...f.receipt.document,
        version: JSON.parse(remote.snapshot()).version,
        error: "latest status",
      },
      packet: JSON.parse(
        remote.export_updates_since(
          JSON.stringify(JSON.parse(remote.snapshot()).version),
        ),
      ),
    });
    await until(() =>
      f.events.some(
        (event) =>
          event.kind === "document" && event.document.error === "latest status",
      ),
    );
    release.resolve();
    await reconnect;
    const view = rpc.documents.snapshot().documents[0];
    assert.equal(view.content, "host REMOTE MORE");
    assert.equal(view.error, "latest status");
    assert.equal(view.inputFailure, undefined);
    push(f, remote, " AGAIN", 5);
    await until(
      () =>
        rpc.documents.snapshot().documents[0].content ===
        "host REMOTE MORE AGAIN",
    );
    assert.equal(rpc.documents.snapshot().documents[0].inputFailure, undefined);
    assert.equal(f.state.offline, false);
  } finally {
    release.resolve();
    await rpc.dispose();
    remote.free();
    f.dispose();
  }
});

test("committed reconnect delivers imported text even when subsequent offline-state IPC fails", async () => {
  const f = await replica();
  const rpc = await rpcReplica(f);
  const remote = BufferBinding.from_snapshot(
    JSON.stringify(f.receipt.packet),
    "3",
  );
  const committed = deferred(),
    release = deferred();
  let replaced = false,
    imported = false,
    residentCalls = 0,
    pauseFailures = 0;
  f.intercept(async (method, params) => {
    if (method === "resident") {
      residentCalls++;
      return {
        status: "error",
        mutations: [],
        error: { code: "IO", message: "derived resident IPC failed" },
      };
    }
    if (method === "replica_host_state" && imported && f.state.offline) {
      pauseFailures++;
      return {
        status: "error",
        mutations: [],
        error: { code: "IO", message: "pause state IPC failed" },
      };
    }
    const reply = await f.wasm.call(method, params);
    if (method === "replica_session") {
      replaced = true;
      committed.resolve();
      await release.promise;
    }
    if (method === "replica_host_state" && replaced) {
      imported = true;
      f.socket().drop();
    }
    return reply;
  });
  try {
    const reconnect = rpc.documents.reconnectSession(true);
    await committed.promise;
    push(f, remote, " REMOTE", 2);
    release.resolve();
    await reconnect;
    const view = rpc.documents.snapshot().documents[0];
    assert.equal(view.content, "host REMOTE");
    assert.equal(view.core!.peerId, "2");
    assert.equal(view.core!.undo.canUndo, false);
    assert.equal(view.inputFailure, undefined);
    assert.equal(rpc.documents.snapshot().connection?.status, "offline");
    assert.match(view.readOnlyReason!, /断开/);
    assert.equal((await f.host.read(f.old.id)).content, "host REMOTE");
    assert.equal(residentCalls, 0);
    assert.ok(pauseFailures > 0);
  } finally {
    release.resolve();
    await rpc.dispose();
    remote.free();
    f.dispose();
  }
});

test("failed reconnect keeps an old import and rebases retained optimistic input", async () => {
  const f = await replica();
  await f.host.connect();
  const rpc = await rpcReplica(f);
  const remote = BufferBinding.from_snapshot(
    JSON.stringify(f.receipt.packet),
    "3",
  );
  const captured = deferred(),
    release = deferred();
  let replacements = 0;
  f.intercept(async (method, params) => {
    if (method === "replica_session") replacements++;
    const reply = await f.wasm.call(method, params);
    if (
      method === "apply" &&
      (params?.command as { kind?: string })?.kind === "import"
    ) {
      captured.resolve();
      await release.promise;
    }
    return reply;
  });
  try {
    push(f, remote, " REMOTE", 2);
    await captured.promise;
    f.state.http.describe = async () => {
      throw new VaultError("IO", "describe failed");
    };
    assert.equal(
      rpc.documents.edit(f.old.id, {
        edits: [{ from: 0, to: 0, insert: "LOCAL " }],
        content: "LOCAL host",
        before: { ranges: [{ anchor: 0, head: 0 }], mainIndex: 0 },
        after: { ranges: [{ anchor: 6, head: 6 }], mainIndex: 0 },
        userEvent: "input.type",
      }),
      true,
    );
    const reconnect = rpc.documents.reconnectSession(true);
    await tick();
    release.resolve();
    await assert.rejects(reconnect, /describe failed/);
    const view = rpc.documents.snapshot().documents[0];
    assert.equal(replacements, 0);
    assert.equal(view.content, "LOCAL host REMOTE");
    assert.equal(view.pending, 1);
    assert.equal(view.inputFailure, undefined);
    assert.equal(view.core!.peerId, "2");
    assert.equal((await f.host.read(f.old.id)).content, "host REMOTE");
    assert.equal(rpc.documents.snapshot().connection?.unconfirmed, true);
  } finally {
    release.resolve();
    await rpc.dispose();
    remote.free();
    f.dispose();
  }
});

test("successful old release closes its view while reconnect prepares an empty baseline", async () => {
  const f = await replica();
  const entered = deferred(),
    release = deferred();
  const viewEntered = deferred(),
    viewRelease = deferred();
  let holdView = false;
  f.request(async (method) => {
    if (method === "set_view") {
      if (holdView) {
        holdView = false;
        viewEntered.resolve();
        await viewRelease.promise;
      }
      return null;
    }
    if (method === "unsubscribe") return null;
    return f.receipt;
  });
  await f.host.connect();
  const rpc = await rpcReplica(f);
  f.intercept(async (method, params) => {
    const reply = await f.wasm.call(method, params);
    if (method === "replica_release") {
      entered.resolve();
      await release.promise;
    }
    return reply;
  });
  try {
    const closing = rpc.documents.closeDocument(f.old.id);
    await entered.promise;
    holdView = true;
    const reconnect = rpc.documents.reconnectSession(true);
    await viewEntered.promise;
    release.resolve();
    assert.equal(await closing, true);
    viewRelease.resolve();
    await reconnect;
    assert.deepEqual(rpc.documents.snapshot().documents, []);
    assert.deepEqual(coreValue(await f.wasm.call("resident", {})), []);
    assert.equal(f.state.subscriptions.size, 0);
    assert.equal(rpc.documents.snapshot().connection?.status, "online");
  } finally {
    release.resolve();
    viewRelease.resolve();
    await rpc.dispose();
    f.dispose();
  }
});

test("old unsubscribe finishing after transport replacement cannot release the new replica", async () => {
  const f = await replica();
  const entered = deferred(),
    release = deferred();
  f.request(async (method) => {
    if (method === "unsubscribe") {
      entered.resolve();
      await release.promise;
      return null;
    }
    if (method === "set_view") return null;
    return f.receipt;
  });
  await f.host.connect();
  const rpc = await rpcReplica(f);
  let releases = 0;
  f.intercept(async (method, params) => {
    if (method === "replica_release") releases++;
    return f.wasm.call(method, params);
  });
  try {
    const closing = rpc.documents.closeDocument(f.old.id);
    await entered.promise;
    const rejected = assert.rejects(closing, /协作会话已关闭/);
    await rpc.documents.reconnectSession(true);
    release.resolve();
    await rejected;
    await tick();
    assert.equal(releases, 0);
    assert.equal(f.state.subscriptions.has(f.old.id), true);
    assert.equal(rpc.documents.snapshot().documents[0].content, "host");
    assert.equal((await f.host.read(f.old.id)).content, "host");
    assert.equal(rpc.documents.snapshot().documents[0].locked, false);
    assert.equal(rpc.documents.snapshot().connection?.status, "online");
  } finally {
    release.resolve();
    await rpc.dispose();
    f.dispose();
  }
});

test("release metadata commits before a queued replacement captures its inventory", async () => {
  const f = await replica();
  f.request(async (method) => (method === "open" ? f.receipt : null));
  await f.host.connect();
  const rpc = await rpcReplica(f);
  const entered = deferred(),
    release = deferred(),
    queued = deferred();
  let replacementIds: string[] | undefined;
  f.intercept(async (method, params) => {
    if (method === "replica_session")
      replacementIds = (params?.documents as { state: { path: string } }[]).map(
        (document) => document.state.path,
      );
    const reply = await f.wasm.call(method, params);
    if (method === "replica_release") {
      entered.resolve();
      await release.promise;
    }
    return reply;
  });
  const execute = f.state.execute.bind(f.host);
  f.state.execute = (...args: [string, ...unknown[]]) => {
    const result = execute(...args);
    if (args[0] === "replica_session") queued.resolve();
    return result;
  };
  const identity = {
    document_id: crypto.randomUUID(),
    history_id: crypto.randomUUID(),
  };
  const recreated = new BufferBinding(
    JSON.stringify(identity),
    "1",
    "recreated file",
  );
  try {
    const closing = rpc.documents.closeDocument(f.old.id);
    await entered.promise;
    const reconnect = rpc.documents.reconnectSession(true);
    await queued.promise;
    assert.equal(replacementIds, undefined);
    release.resolve();
    assert.equal(await closing, true);
    await reconnect;
    assert.deepEqual(replacementIds, []);
    assert.deepEqual(rpc.documents.snapshot().documents, []);
    assert.equal(f.state.subscriptions.size, 0);
    assert.equal(f.state.hosts.size, 0);
    assert.equal(f.state.received.size, 0);
    assert.deepEqual(coreValue(await f.wasm.call("resident", {})), []);
    const version = JSON.parse(recreated.snapshot()).version;
    f.request(async (method) =>
      method === "open"
        ? {
            ...f.receipt,
            document: {
              ...f.receipt.document,
              id: identity.document_id,
              version,
              savedVersion: version,
              savedContent: "recreated file",
            },
            packet: JSON.parse(recreated.export_snapshot()),
          }
        : null,
    );
    assert.equal(await rpc.documents.open(vaultPath("a.md")), true);
    assert.equal(
      rpc.documents.snapshot().documents[0].content,
      "recreated file",
    );
    assert.equal(
      rpc.documents.snapshot().documents[0].id,
      identity.document_id,
    );
  } finally {
    release.resolve();
    await rpc.dispose();
    recreated.free();
    f.dispose();
  }
});

test("a queued old release rechecks its transport when it enters the core lease", async () => {
  const f = await replica();
  const unsubscribe = deferred(),
    acknowledge = deferred();
  f.request(async (method) => {
    if (method === "unsubscribe") {
      unsubscribe.resolve();
      await acknowledge.promise;
      return null;
    }
    return method === "open" ? f.receipt : null;
  });
  await f.host.connect();
  const rpc = await rpcReplica(f);
  const leased = deferred(),
    releaseLease = deferred();
  const queuedRelease = deferred(),
    queuedReplacement = deferred();
  const execute = f.state.execute.bind(f.host);
  f.state.execute = (...args: [string, ...unknown[]]) => {
    const result = execute(...args);
    if (args[0] === "replica_release") queuedRelease.resolve();
    if (args[0] === "replica_session") queuedReplacement.resolve();
    return result;
  };
  let releases = 0;
  f.intercept(async (method, params) => {
    if (method === "replica_release") releases++;
    return f.wasm.call(method, params);
  });
  let capture: Promise<unknown> | undefined;
  try {
    const closing = rpc.documents.closeDocument(f.old.id);
    const rejected = assert.rejects(closing, /协作会话已替换/);
    await unsubscribe.promise;
    capture = f.host.withSource([f.old.id], async () => {
      leased.resolve();
      await releaseLease.promise;
    });
    await leased.promise;
    acknowledge.resolve();
    await queuedRelease.promise;
    const reconnect = rpc.documents.reconnectSession(true);
    await queuedReplacement.promise;
    releaseLease.resolve();
    await capture;
    await reconnect;
    await rejected;
    assert.equal(releases, 0);
    assert.equal(f.state.subscriptions.has(f.old.id), true);
    assert.equal(rpc.documents.snapshot().documents[0].id, f.old.id);
    assert.equal(rpc.documents.snapshot().documents[0].content, "host");
    assert.equal((await f.host.read(f.old.id)).content, "host");
  } finally {
    acknowledge.resolve();
    releaseLease.resolve();
    await capture;
    await rpc.dispose();
    f.dispose();
  }
});
