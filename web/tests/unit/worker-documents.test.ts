import { test } from "node:test";
import assert from "node:assert/strict";
import { WorkerDocuments } from "../../src/lib/editor/client/documents";
import { EditorClient, type MessageTransport } from "../../src/lib/editor/rpc";
import { vaultPath } from "../../src/lib/vault/path";
import type {
  ServiceDocument,
  WorkerMessage,
  WorkerRequest,
  ViewEdit,
} from "../../src/lib/editor/contract";

class Transport implements MessageTransport {
  sent: WorkerRequest[] = [];
  listeners = new Set<(event: MessageEvent<WorkerMessage>) => void>();
  sequence = 0;
  constructor(readonly reply: (request: WorkerRequest) => unknown) {}
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
  emit(message: WorkerMessage) {
    for (const listener of this.listeners)
      listener({ data: message } as MessageEvent<WorkerMessage>);
  }
  postMessage(request: WorkerRequest) {
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
    saving: false,
    error: null,
    conflict: false,
    conflictResolution: "shared",
    core: {
      version: {
        identity: { document_id: "file", history_id: "history" },
        clocks: { "1": 4 },
      },
      durableVersion: null,
      writerId: "2",
      undo: { can_undo: false, can_redo: false, group_open: false },
      historyError: null,
    },
  };
}
function setup(reply: (request: WorkerRequest) => unknown, remote = true) {
  const transport = new Transport(reply);
  const client = new EditorClient(transport);
  transport.emit({
    kind: "ready",
    identity: {
      instanceId: "client",
      vault: { vaultId: "vault", historyId: "history" },
    },
    sessionId: "session",
  });
  const documents = new WorkerDocuments(client, () => {}, remote);
  return { transport, client, documents };
}
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

test("rejected input retains its projection and withdraws dependent inputs using current accepted text", async () => {
  let accepted = document();
  const { transport, client, documents } = setup((request) => {
    if (request.method === "edit")
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
    transport.sent.filter((request) => request.method === "edit").length,
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
    change: { before: "base", edits: [{ from: 0, to: 0, insert: "R" }] },
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
    request.method === "edit"
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
    request.method === "edit"
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
