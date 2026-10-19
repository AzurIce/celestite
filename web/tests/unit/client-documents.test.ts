import { test } from "node:test";
import assert from "node:assert/strict";
import { ClientDocuments } from "../../src/lib/editor/client/documents";
import { EditorClient, type MessageTransport } from "../../src/lib/editor/rpc";
import { vaultPath } from "../../src/lib/vault/path";
import type {
  BufferCommand,
  ServiceDocument,
  ServiceMessage,
  ServiceRequest,
  ViewEdit,
} from "../../src/lib/editor/contract";

class Transport implements MessageTransport {
  sent: ServiceRequest[] = [];
  listeners = new Set<(event: MessageEvent<ServiceMessage>) => void>();
  sequence = 0;
  constructor(readonly reply: (request: ServiceRequest) => unknown) {}
  addEventListener(
    _type: "message",
    listener: (event: MessageEvent<ServiceMessage>) => void,
  ) {
    this.listeners.add(listener);
  }
  removeEventListener(
    _type: "message",
    listener: (event: MessageEvent<ServiceMessage>) => void,
  ) {
    this.listeners.delete(listener);
  }
  emit(message: ServiceMessage) {
    for (const listener of this.listeners)
      listener({ data: message } as MessageEvent<ServiceMessage>);
  }
  postMessage(request: ServiceRequest) {
    this.sent.push(request);
    queueMicrotask(() =>
      this.emit({
        kind: "reply",
        requestId: request.requestId,
        result: this.reply(request),
      }),
    );
  }
  document(document: ServiceDocument) {
    this.emit({ kind: "document", sequence: ++this.sequence, document });
  }
}
const selection = (pos: number) => ({
  ranges: [{ anchor: pos, head: pos }],
  mainIndex: 0,
});
const input = (content: string): ViewEdit => ({
  edits: [
    {
      from: content.length - 1,
      to: content.length - 1,
      insert: content.slice(-1),
    },
  ],
  content,
  before: selection(content.length - 1),
  after: selection(content.length),
  userEvent: "input.type",
});
function document(): ServiceDocument {
  return {
    id: "file",
    path: vaultPath("a.md"),
    content: "base",
    savedContent: "base",
    bom: false,
    lineEnding: "\n",
    readOnlyReason: null,
    canPreview: true,

    error: null,
    conflict: false,
    conflictResolution: "shared",
    core: {
      version: {
        identity: { document_id: "file", history_id: "history" },
        clocks: { "1": 4 },
      },
      peerId: "2",
      undo: { canUndo: false, canRedo: false },
      recoveryError: null,
    },
  };
}
function setup(reply: (request: ServiceRequest) => unknown, remote = true) {
  const transport = new Transport((request) =>
    request.method === "collaboration" ? null : reply(request),
  );
  const client = new EditorClient(transport);
  transport.emit({
    kind: "ready",
    identity: {
      instanceId: "client",
      vault: { vaultId: "vault", historyId: "history" },
    },
    sessionId: "session",
  });
  const documents = new ClientDocuments(client, () => {}, remote);
  return { transport, client, documents };
}
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

test("consecutive input receipts advance accepted history without replacing the optimistic projection", async () => {
  let accepted = document();
  const projections: string[] = [];
  const { transport, client, documents } = setup((request) => {
    if (request.method !== "apply") return accepted;
    const command = request.params.command as BufferCommand;
    assert.equal(command.kind, "edit");
    if (command.kind !== "edit") throw new Error("expected edit");
    assert.deepEqual(command.base, accepted.core!.version);
    accepted = {
      ...accepted,
      content: accepted.content + (accepted.content === "base" ? "X" : "Y"),
      core: {
        ...accepted.core!,
        version: {
          ...accepted.core!.version,
          clocks: { "1": 4, "2": accepted.content === "base" ? 1 : 2 },
        },
      },
    };
    return { document: accepted, edits: [] };
  });
  await documents.open(vaultPath("a.md"));
  documents.subscribe((state) => projections.push(state.documents[0].content));
  assert.equal(documents.edit("file", input("baseX")), true);
  assert.equal(documents.edit("file", input("baseXY")), true);
  await settle();
  assert.deepEqual(projections, ["baseX", "baseXY", "baseXY", "baseXY"]);
  const view = documents.snapshot().documents[0];
  assert.equal(view.pending, 0);
  assert.equal(view.dirty, true);
  assert.equal("acceptedContent" in view, false);
  assert.equal("inputs" in view, false);
  assert.equal(transport.sent.filter((r) => r.method === "apply").length, 2);
  client.dispose();
});

test("a recovery checkpoint failure warns without blocking subsequent input", async () => {
  const initial = document();
  let applied = 0;
  const { transport, client, documents } = setup((request) => {
    if (request.method !== "apply") return initial;
    applied++;
    return {
      document: {
        ...initial,
        content: applied === 1 ? "baseX" : "baseXY",
        core: {
          ...initial.core!,
          version: {
            ...initial.core!.version,
            clocks: { "1": 4, "2": applied },
          },
          recoveryError: "draft checkpoint failed",
        },
      },
      edits: [],
    };
  });
  await documents.open(vaultPath("a.md"));
  assert.equal(documents.edit("file", input("baseX")), true);
  await settle();
  assert.equal(documents.edit("file", input("baseXY")), true);
  await settle();
  const view = documents.snapshot().documents[0];
  assert.equal(view.content, "baseXY");
  assert.equal(view.pending, 0);
  assert.equal(view.error, "draft checkpoint failed");
  assert.equal(view.inputFailure, undefined);
  assert.equal(await documents.discardRejectedInput("file"), false);
  assert.equal(transport.sent.filter((r) => r.method === "apply").length, 2);
  client.dispose();
});

for (const discard of [false, true]) {
  test(`reconnect observes the in-flight input outcome before replacing the session (discard=${discard})`, async () => {
    const initial = document();
    const accepted = {
      ...initial,
      content: "baseX",
      core: {
        ...initial.core!,
        version: { ...initial.core!.version, clocks: { "1": 4, "2": 1 } },
      },
    };
    const { transport, client, documents } = setup((request) =>
      request.method === "reconnect"
        ? { documents: [accepted], sequence: transport.sequence }
        : initial,
    );
    try {
      await documents.open(vaultPath("a.md"));
      const post = transport.postMessage.bind(transport);
      let pending!: ServiceRequest;
      transport.postMessage = (request) => {
        if (request.method !== "apply") return post(request);
        pending = request;
        transport.sent.push(request);
      };
      documents.edit("file", input("baseX"));
      await settle();
      assert.equal(pending.method, "apply");
      const reconnecting = documents.reconnectSession(discard);
      await settle();
      assert.equal(
        transport.sent.some((r) => r.method === "reconnect"),
        false,
      );
      assert.equal(documents.snapshot().documents[0].pending, 1);
      transport.emit({
        kind: "reply",
        requestId: pending.requestId,
        result: { document: accepted, edits: [] },
      });
      await reconnecting;
      assert.equal(documents.snapshot().documents[0].pending, 0);
      assert.equal(documents.snapshot().documents[0].content, "baseX");
      assert.equal(documents.snapshot().connection?.status, "online");
    } finally {
      client.dispose();
    }
  });
}

for (const online of [false, true]) {
  test(`reconnect installs committed snapshots and uses the latest connection status (online=${online})`, async () => {
    const joined = {
      ...document(),
      content: "joined history",
      core: { ...document().core!, peerId: "3" },
    };
    const { transport, client, documents } = setup((request) => {
      if (request.method !== "reconnect") return document();
      transport.emit({
        kind: "connection",
        sequence: ++transport.sequence,
        connection: { status: "offline", error: "connection lost" },
      });
      if (online)
        transport.emit({
          kind: "connection",
          sequence: ++transport.sequence,
          connection: { status: "online", error: null },
        });
      // The service has committed the new core before returning these snapshots.
      // A disconnect before its reply cannot leave the UI on the old history.
      return { documents: [joined], sequence: transport.sequence };
    });
    try {
      await documents.open(vaultPath("a.md"));
      await documents.reconnectSession();
      const state = documents.snapshot();
      assert.equal(state.documents[0].content, "joined history");
      assert.equal(state.documents[0].core?.peerId, "3");
      assert.equal(state.connection?.status, online ? "online" : "offline");
      assert.equal(state.connection?.error, online ? null : "connection lost");
      if (!online)
        assert.equal(documents.edit("file", input("joined historyX")), false);
    } finally {
      client.dispose();
    }
  });
}

test("rejected input retains its projection and withdraws dependent inputs using current accepted text", async () => {
  let accepted = document();
  const { transport, client, documents } = setup((request) => {
    if (request.method === "apply")
      return {
        document: accepted,
        edits: [],
        rejection: { code: "Unsupported", message: "Text exceeds 5 MiB" },
      };
    return accepted;
  });
  await documents.open(vaultPath("a.md"));
  documents.edit("file", input("baseX"));
  documents.edit("file", input("baseXY"));
  await settle();
  let snapshot = documents.snapshot();
  assert.equal(snapshot.connection?.status, "online");
  assert.equal(snapshot.documents[0].content, "baseXY");
  assert.equal(snapshot.documents[0].inputFailure?.outcome, "rejected");
  assert.equal(
    transport.sent.filter((request) => request.method === "apply").length,
    1,
  );
  accepted = {
    ...accepted,
    content: "Rbase",
    core: {
      ...accepted.core!,
      version: { ...accepted.core!.version, clocks: { "1": 4, "3": 1 } },
    },
  };
  transport.document({
    ...accepted,
    change: {
      before: document().core!.version,
      edits: [{ from: 0, to: 0, insert: "R" }],
    },
  });
  assert.equal(documents.snapshot().documents[0].content, "RbaseXY");
  assert.equal(await documents.discardRejectedInput("file"), true);
  snapshot = documents.snapshot();
  assert.equal(snapshot.documents[0].content, "Rbase");
  assert.equal(snapshot.documents[0].pending, 0);
  assert.equal(snapshot.documents[0].locked, false);
  assert.equal(snapshot.documents[0].inputFailure, undefined);
  assert.equal(documents.edit("file", input("RbaseZ")), true);
  await settle();
  client.dispose();
});

test("unknown failures cannot be withdrawn as rejected edits", async () => {
  const { transport, client, documents } = setup(() => document());
  await documents.open(vaultPath("a.md"));
  const original = transport.postMessage.bind(transport);
  transport.postMessage = (request) =>
    request.method === "apply"
      ? queueMicrotask(() =>
          transport.emit({
            kind: "reply",
            requestId: request.requestId,
            error: { code: "IO", message: "receipt lost" },
          }),
        )
      : original(request);
  documents.edit("file", input("baseX"));
  await settle();
  assert.equal(
    documents.snapshot().documents[0].inputFailure?.outcome,
    "unknown",
  );
  assert.equal(await documents.discardRejectedInput("file"), false);
  assert.equal(documents.snapshot().documents[0].content, "baseX");
  client.dispose();
});

test("shared conflicts expose retry and never submit discard or overwrite", async () => {
  const shared = { ...document(), content: "shared draft" };
  const { transport, client, documents } = setup((request) =>
    request.method === "save"
      ? { ...shared, conflict: true, error: "disk conflict" }
      : shared,
  );
  await documents.open(vaultPath("a.md"));
  assert.equal(await documents.requestSave("file"), false);
  assert.equal(await documents.resolveConflict("discard"), false);
  assert.equal(await documents.resolveConflict("overwrite"), false);
  assert.equal(
    transport.sent.filter((request) => request.method === "resolve").length,
    0,
  );
  assert.equal(await documents.resolveConflict("retry"), true);
  assert.equal(
    transport.sent.find((request) => request.method === "resolve")?.params
      .action,
    "retry",
  );
  client.dispose();
});

test("closing shared views and connections does not request file saves", async () => {
  const shared = { ...document(), content: "shared draft" };
  const { transport, documents } = setup(() => shared);
  await documents.open(vaultPath("a.md"));
  assert.equal(await documents.closeDocument("file"), true);
  await documents.open(vaultPath("a.md"));
  await documents.close();
  assert.equal(
    transport.sent.filter(
      (request) => request.method === "save" || request.method === "flush",
    ).length,
    0,
  );
  assert.equal(transport.sent.at(-1)?.method, "close");
});

test("closing a connection refuses retained input without submitting a save", async () => {
  const { transport, client, documents } = setup((request) =>
    request.method === "apply"
      ? {
          document: document(),
          edits: [],
          rejection: { code: "InvalidEdit", message: "invalid text" },
        }
      : document(),
  );
  await documents.open(vaultPath("a.md"));
  documents.edit("file", input("baseX"));
  await settle();
  await assert.rejects(documents.close(), /连接仍保留/);
  assert.equal(
    transport.sent.some(
      (request) => request.method === "save" || request.method === "close",
    ),
    false,
  );
  assert.equal(documents.snapshot().documents[0].content, "baseX");
  client.dispose();
});

test("reconnect drops pre-baseline metadata even when its history version matches the new snapshot", async () => {
  const joined = {
    ...document(),
    content: "new session",
    core: { ...document().core!, peerId: "3" },
  };
  const { transport, client, documents } = setup((request) => {
    if (request.method !== "reconnect") return document();
    transport.document({
      ...joined,
      content: undefined,
      error: "old session error",
      readOnlyReason: "old session permission",
    });
    return { documents: [joined], sequence: transport.sequence };
  });
  try {
    await documents.open(vaultPath("a.md"));
    await documents.reconnectSession();
    const view = documents.snapshot().documents[0];
    assert.equal(view.content, "new session");
    assert.equal(view.error, null);
    assert.equal(view.readOnlyReason, null);
    assert.equal(view.core?.peerId, "3");
  } finally {
    client.dispose();
  }
});
