import { test } from "node:test";
import assert from "node:assert/strict";
import { RemoteEditorHost } from "../../src/lib/editor/remote/host";
import type { RemoteTransport } from "../../src/lib/editor/remote/transport";
import type {
  HttpVaultBackend,
  RemoteVaultDescriptor,
} from "../../src/lib/vault/http";
import { vaultPath } from "../../src/lib/vault/path";
import { EditorHost } from "../../src/lib/editor/runtime/host";
import type {
  CoreDocument,
  CoreMutation,
  CorePort,
  CoreReply,
} from "../../src/lib/editor/core";
import type {
  BufferCommand,
  ServiceEvent,
  Version,
} from "../../src/lib/editor/contract";
import type { VaultBackend } from "../../src/lib/vault/types";
import { VaultError } from "../../src/lib/vault/errors";
import { EditGroups } from "../../src/lib/editor/commands";

const version = (clock: number): Version => ({
  identity: { document_id: "doc", history_id: "history" },
  clocks: { "1": clock },
});
const before: CoreDocument = {
  id: "doc",
  path: "a.md",
  snapshot: { text: "base", version: version(4), revision: 0 },
  undo: { canUndo: false, canRedo: false },
  writerId: "1",
  savedContent: "base",
  savedVersion: version(4),
  dirty: false,
  bom: false,
  lineEnding: "\n",
  deleted: false,
  conflict: false,
  durableVersion: null,
  persistenceError: null,
  error: null,
  autosaveDelay: null,
  backendRevision: "disk",
};
const mutation: CoreMutation = {
  document: {
    ...before,
    snapshot: { text: "baseX", version: version(5), revision: 1 },
    undo: { canUndo: true, canRedo: false },
    dirty: true,
  },
  update: {
    cause: { kind: "local", origin: "typing" },
    changed: true,
    before: version(4),
    after: version(5),
    beforeLen: 4,
    afterLen: 5,
    revision: 1,
    edits: [{ from: 4, to: 4, insert: "X" }],
    undo: { canUndo: true, canRedo: false },
    restored: null,
    pending: false,
    operation: {
      identity: version(4).identity,
      kind: "updates",
      data: [1, 2, 3],
    },
  },
  history: { status: "committed", version: version(5), durable: false },
};
const command: BufferCommand = {
  kind: "edit",
  base: version(4),
  input: { kind: "edits", edits: mutation.update.edits },
  undo: { positions: [] },
};

// These tests exercise the transport contract, not a replacement text engine.
function port(reply: CoreReply): CorePort {
  return {
    async call(method) {
      return JSON.stringify(
        method === "read"
          ? { status: "ok", value: before, mutations: [] }
          : reply,
      );
    },
  };
}
class TestHost extends EditorHost {
  failAfterAcceptance = false;
  run(method: string) {
    return this.execute(method);
  }
  protected override async onMutation(value: CoreMutation, inReply = false) {
    await super.onMutation(value, inReply);
    if (this.failAfterAcceptance)
      throw new VaultError(
        "InvalidEdit",
        "transport rejected an already accepted edit",
      );
  }
}
function host(reply: CoreReply) {
  const events: ServiceEvent[] = [];
  const instance = new TestHost(
    port(reply),
    {} as VaultBackend,
    (event) => events.push(event),
    () => {},
  );
  return { instance, events };
}

test("an explicit core rejection is not inferred from an error-code whitelist", async () => {
  const { instance, events } = host({
    status: "error",
    error: { code: "IO", message: "history is unavailable" },
    mutations: [],
  });
  const result = await instance.apply("doc", command);
  assert.equal(result.rejection?.code, "IO");
  assert.deepEqual(events, []);
});

test("errors after acceptance never turn into rejected input", async () => {
  const { instance, events } = host({
    status: "ok",
    value: "doc",
    mutations: [mutation],
  });
  instance.failAfterAcceptance = true;
  await assert.rejects(instance.apply("doc", command), /already accepted/);
  assert.equal(events.length, 1);
});

test("accepted external changes are dispatched before a failing IO command reports its error", async () => {
  const external: CoreMutation = {
    ...mutation,
    update: {
      ...mutation.update,
      cause: { kind: "import", origin: "filesystem" },
    },
  };
  const { instance, events } = host({
    status: "error",
    error: { code: "IO", message: "write failed" },
    mutations: [external],
  });
  await assert.rejects(instance.run("observe_files"), /write failed/);
  assert.equal(events.length, 1);
  const event = events[0];
  assert.equal(event.kind, "document");
  if (event.kind !== "document") throw new Error("missing document event");
  assert.deepEqual(event.document.change, {
    before: version(4),
    edits: mutation.update.edits,
  });
  assert.equal(event.document.content, "baseX");
});

test("gesture grouping uses input time and explicit Vim sessions, independently of IO latency", () => {
  const groups = new EditGroups();
  const first = groups.next("doc", "input.type", 0);
  assert.equal(groups.next("doc", "input.type", 100), first);
  assert.notEqual(groups.next("doc", "input.type", 1000), first);
  const vim = groups.next("doc", "input.vim.insert.1", 1001);
  assert.equal(groups.next("doc", "input.vim.insert.1", 100000), vim);
  assert.notEqual(groups.next("doc", "input.vim.insert.2", 100001), vim);
  assert.equal(groups.next("doc", "input.paste", 100002), null);
  groups.break("doc");
  assert.notEqual(groups.next("doc", "input.type", 100003), first);
});

test("an import cannot interleave between reading a base and accepting a rebased edit", async () => {
  const calls: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const core: CorePort = {
    async call(method) {
      calls.push(method);
      if (method === "read") {
        await gate;
        return JSON.stringify({ status: "ok", value: before, mutations: [] });
      }
      return JSON.stringify(
        method === "apply"
          ? { status: "ok", value: "doc", mutations: [mutation] }
          : { status: "ok", value: null, mutations: [] },
      );
    },
  };
  const instance = new TestHost(
    core,
    {} as VaultBackend,
    () => {},
    () => {},
  );
  const edit = instance.apply("doc", command);
  const imported = instance.run("observe_files");
  await Promise.resolve();
  assert.deepEqual(calls, ["read"]);
  release();
  await edit;
  await imported;
  assert.deepEqual(calls, ["read", "apply", "observe_files"]);
});

test("concurrent open replies join a replica once and accept metadata in receipt order", async () => {
  const calls: string[] = [];
  const core: CorePort = {
    async call(method, params) {
      calls.push(method);
      // Each call yields, so both network replies reach the host before join ends.
      await Promise.resolve();
      const state = JSON.parse(params).state;
      return JSON.stringify({
        status: "ok",
        value: state
          ? {
              ...before,
              snapshot: { ...before.snapshot, version: state.version },
            }
          : null,
        mutations: [],
      });
    },
  };
  let sequence = 0;
  const transport = {
    async request() {
      const current = ++sequence;
      return {
        kind: "document",
        sequence: current,
        writerId: "2",
        document: {
          ...before,
          version: version(current + 4),
          savedContent: "base",
        },
        packet: { identity: version(4).identity, kind: "snapshot", data: [] },
      };
    },
  } as unknown as RemoteTransport;
  const instance = new RemoteEditorHost(
    core,
    { packageResources: () => undefined } as unknown as HttpVaultBackend,
    { readOnly: false } as RemoteVaultDescriptor,
    () => {},
    () => {},
  );
  Object.assign(instance, { transport, offline: false });
  const documents = await Promise.all([
    instance.open(vaultPath("a.md")),
    instance.open(vaultPath("a.md")),
  ]);
  assert.equal(calls.filter((method) => method === "replica_join").length, 1);
  assert.equal(calls.filter((method) => method === "apply").length, 1);
  assert.deepEqual(
    documents.map((document) => document.core?.version),
    [version(5), version(6)],
  );
});
