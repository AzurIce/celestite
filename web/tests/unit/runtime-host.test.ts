import { test } from "node:test";
import assert from "node:assert/strict";
import { RemoteEditorSession } from "../../src/lib/editor/remote/editor-session";
import type { RemoteTransport } from "../../src/lib/editor/remote/transport";
import type {
  HttpVaultBackend,
  RemoteVaultDescriptor,
} from "../../src/lib/vault/http";
import { vaultPath } from "../../src/lib/vault/path";
import { EditorSession } from "../../src/lib/editor/runtime/session";
import { LocalEditorSession } from "../../src/lib/editor/local/session";
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
import { coreReady, MemoryRecoveryFiles } from "./core-runtime";
import { createBrowserIo } from "../../src/lib/editor/local/io";
import { EditorBinding } from "../../src/lib/editor/generated/celestite_core";
import { wasmCore, coreValue } from "../../src/lib/editor/core";
import { EditGroups } from "../../src/lib/editor/commands";

const version = (clock: number): Version => ({
  identity: { document_id: "doc", history_id: "history" },
  clocks: { "1": clock },
});
const before: CoreDocument = {
  id: "doc",
  path: "a.md",
  version: version(4),
  snapshot: { text: "base", stateRevision: 0 },
  undo: { canUndo: false, canRedo: false },
  peerId: "1",
  savedContent: "base",
  savedVersion: version(4),
  dirty: false,
  bom: false,
  lineEnding: "\n",
  deleted: false,
  conflict: false,
  recoveryError: null,
  recoveryDelay: null,
  error: null,
  autosaveDelay: null,
  fileRevision: "disk",
};
const mutation: CoreMutation = {
  document: {
    ...before,
    version: version(5),
    snapshot: { text: "baseX", stateRevision: 1 },
    undo: { canUndo: true, canRedo: false },
    dirty: true,
  },
  update: {
    cause: { kind: "local" },
    changed: true,
    before: version(4),
    after: version(5),
    beforeLen: 4,
    afterLen: 5,
    stateRevision: 1,
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
};
const command: BufferCommand = {
  kind: "edit",
  base: version(4),
  input: { kind: "edits", edits: mutation.update.edits },
  undo: { positions: [] },
};

// These tests exercise the transport contract, not a replacement text engine.
test("readonly source captures use the core queue and request only explicit bodies", async () => {
  const requests: { method: string; params: Record<string, unknown> }[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const source = {
    epoch: 1,
    documents: [{ id: "doc", path: "a.md", version: before.version }],
    snapshots: [],
  };
  const host = new EditorSession(
    {
      async call(method, params) {
        requests.push({ method, params });
        if (requests.length === 1) await gate;
        return { status: "ok", value: source, mutations: [] };
      },
    },
    () => {},
  );
  const metadata = host.withSource([], (captured) => {
    // A later core request cannot start between capture and consumption.
    assert.equal(requests.length, 1);
    return captured;
  });
  const ids = Object.freeze(["doc"]);
  const bodies = host.readSource(ids);
  await Promise.resolve();
  assert.equal(requests.length, 1);
  release();
  assert.deepEqual(await metadata, source);
  await bodies;
  assert.deepEqual(requests, [
    { method: "document_source", params: { ids: [] } },
    { method: "document_source", params: { ids: ["doc"] } },
  ]);
  assert.deepEqual(ids, ["doc"]);
});

function port(reply: CoreReply): CorePort {
  return {
    async call(method) {
      return method === "read"
        ? { status: "ok", value: before, mutations: [] }
        : reply;
    },
  };
}
class TestHost extends LocalEditorSession {
  failAfterAcceptance = false;
  run(method: string) {
    return this.execute(method);
  }
  show(document: CoreDocument) {
    this.publish(document);
  }
  protected override onMutation(value: CoreMutation, inReply = false) {
    super.onMutation(value, inReply);
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
    error: { code: "IO", message: "owner is unavailable" },
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
      cause: { kind: "import" },
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
        return { status: "ok", value: before, mutations: [] };
      }
      return method === "apply"
        ? { status: "ok", value: "doc", mutations: [mutation] }
        : { status: "ok", value: null, mutations: [] };
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
      const state = params.state as { version: Version } | undefined;
      return {
        status: "ok",
        value: state
          ? {
              ...before,
              version: state.version,
            }
          : null,
        mutations: [],
      };
    },
  };
  let sequence = 0;
  const transport = {
    async request() {
      const current = ++sequence;
      return {
        kind: "document",
        sequence: current,
        peerId: "2",
        document: {
          ...before,
          version: version(current + 4),
          savedContent: "base",
        },
        packet: { identity: version(4).identity, kind: "snapshot", data: [] },
      };
    },
  } as unknown as RemoteTransport;
  const instance = new RemoteEditorSession(
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

async function withRecoveryClock(
  run: (clock: {
    now(): number;
    advance(ms: number): Promise<void>;
    pending(): number;
    schedule(task: () => Promise<unknown>): void;
  }) => Promise<void>,
) {
  const set = globalThis.setTimeout;
  const clear = globalThis.clearTimeout;
  const dateNow = Date.now;
  const epoch = dateNow();
  const timers = new Map<number, { due: number; callback: () => void }>();
  const pending: Promise<unknown>[] = [];
  let now = 0;
  let id = 0;
  Date.now = () => epoch + now;
  globalThis.setTimeout = ((callback: () => void, delay = 0) => {
    const timer = ++id;
    timers.set(timer, { due: now + delay, callback });
    return timer;
  }) as unknown as typeof globalThis.setTimeout;
  globalThis.clearTimeout = ((timer: unknown) => {
    timers.delete(Number(timer));
  }) as typeof globalThis.clearTimeout;
  try {
    await run({
      now: () => now,
      pending: () => timers.size,
      schedule: (task) => {
        pending.push(task());
      },
      async advance(ms) {
        const end = now + ms;
        let callbacks = 0;
        while (true) {
          assert.ok(callbacks++ < 100, "background timers must not spin");
          const next = [...timers]
            .filter(([, timer]) => timer.due <= end)
            .sort((a, b) => a[1].due - b[1].due)[0];
          if (!next) break;
          now = next[1].due;
          timers.delete(next[0]);
          next[1].callback();
          // The production scheduler serializes these tasks; both success and
          // failure are observed before the next synthetic deadline.
          await Promise.allSettled(pending.splice(0));
        }
        now = end;
      },
    });
  } finally {
    globalThis.setTimeout = set;
    globalThis.clearTimeout = clear;
    Date.now = dateNow;
  }
}

test("recovery timers coalesce continuous publications at the first 500 ms deadline", async () => {
  await withRecoveryClock(async (clock) => {
    let state: CoreDocument = { ...mutation.document, recoveryDelay: 500 };
    const checkpoints: number[] = [];
    const host = new TestHost(
      {
        async call(method) {
          if (method === "checkpoint") {
            checkpoints.push(clock.now());
            state = { ...state, recoveryDelay: null };
          }
          return {
            status: "ok",
            mutations: [],
            value: method === "resident" ? [state] : state,
          };
        },
      },
      {} as VaultBackend,
      () => {},
      clock.schedule,
    );
    try {
      host.show(state);
      await clock.advance(200);
      state = { ...state, recoveryDelay: 300 };
      host.show(state);
      await clock.advance(200);
      state = { ...state, recoveryDelay: 100 };
      host.show(state);
      // Closing a view keeps the owner and its pending text checkpoint.
      await host.releaseDocument(state.id);
      await clock.advance(99);
      assert.deepEqual(checkpoints, []);
      await clock.advance(1);
      assert.deepEqual(checkpoints, [500]);
      assert.equal(clock.pending(), 0);
    } finally {
      host.dispose();
    }
  });
});

test("failed timed checkpoints publish recovery errors and wait for fresh input before retrying", async () => {
  await withRecoveryClock(async (clock) => {
    let state: CoreDocument = { ...mutation.document, recoveryDelay: 500 };
    let fail = true;
    let checkpoints = 0;
    const events: ServiceEvent[] = [];
    const host = new TestHost(
      {
        async call(method) {
          if (method === "checkpoint") {
            checkpoints++;
            state = {
              ...state,
              recoveryDelay: null,
              recoveryError: fail ? "checkpoint failed" : null,
            };
            if (fail)
              return {
                status: "error",
                mutations: [],
                error: { code: "IO", message: "checkpoint failed" },
              };
          }
          return {
            status: "ok",
            mutations: [],
            value: method === "resident" ? [state] : state,
          };
        },
      },
      {} as VaultBackend,
      (event) => events.push(event),
      clock.schedule,
    );
    try {
      host.show(state);
      await clock.advance(500);
      const last = events.filter((event) => event.kind === "document").at(-1)!;
      assert.equal(last.document.core?.recoveryError, "checkpoint failed");
      assert.equal(clock.pending(), 0);
      await clock.advance(5000);
      assert.equal(checkpoints, 1);
      fail = false;
      state = { ...state, recoveryDelay: 500 };
      host.show(state);
      await clock.advance(500);
      assert.equal(checkpoints, 2);
      assert.equal(
        events.filter((event) => event.kind === "document").at(-1)!.document
          .core?.recoveryError,
        null,
      );
      state = { ...state, recoveryDelay: 500 };
      host.show(state);
      host.dispose();
      await clock.advance(500);
      assert.equal(checkpoints, 2);
    } finally {
      host.dispose();
    }
  });
});

test("local composition observation applies only to external directory owners", async () => {
  for (const observeExternal of [false, true]) {
    const requests: { method: string; params: Record<string, unknown> }[] = [];
    const host = new LocalEditorSession(
      {
        async call(method, params) {
          requests.push({ method, params });
          return {
            status: "ok",
            mutations: [],
            value:
              method === "resident"
                ? [before]
                : method === "read"
                  ? before
                  : [],
          };
        },
      },
      {} as VaultBackend,
      () => {},
      () => {},
      observeExternal,
    );
    await host.composition(before.id, true);
    assert.deepEqual(requests, []);
    await host.composition(before.id, false);
    assert.deepEqual(requests, [
      { method: "read", params: { id: before.id } },
      ...(observeExternal
        ? [
            { method: "resident", params: {} },
            { method: "observe_files", params: { ids: [before.id] } },
          ]
        : []),
    ]);
    host.dispose();
  }
});

test("remote checkpoints wait for host confirmation without invoking local recovery", async () => {
  const calls: string[] = [];
  const transport = {} as RemoteTransport;
  const host = new RemoteEditorSession(
    {
      async call(method) {
        calls.push(method);
        assert.equal(method, "read");
        return { status: "ok", value: before, mutations: [] };
      },
    },
    {} as HttpVaultBackend,
    { readOnly: false } as RemoteVaultDescriptor,
    () => {},
    () => {},
  );
  Object.assign(host, {
    transport,
    offline: false,
    sync: {
      async wait(id: string, checkpoint: Version) {
        calls.push("confirm");
        assert.equal(id, before.id);
        assert.deepEqual(checkpoint, before.version);
      },
    },
  });
  const document = await host.checkpoint(before.id);
  assert.equal(document.id, before.id);
  assert.deepEqual(calls, ["read", "confirm", "read"]);
});

test("remote publication has no local autosave or recovery timers", async () => {
  await withRecoveryClock(async (clock) => {
    class PublishedRemoteSession extends RemoteEditorSession {
      show(document: CoreDocument) {
        this.publish(document);
      }
    }
    const events: ServiceEvent[] = [];
    const host = new PublishedRemoteSession(
      port({ status: "ok", value: null, mutations: [] }),
      {} as HttpVaultBackend,
      { readOnly: false } as RemoteVaultDescriptor,
      (event) => events.push(event),
      clock.schedule,
    );
    host.show({ ...before, autosaveDelay: 0, recoveryDelay: 0 });
    assert.equal(events.length, 1);
    assert.equal(clock.pending(), 0);
  });
});

test("two failed recovery drafts stop background retries while another document can checkpoint", async () => {
  await coreReady;
  await withRecoveryClock(async (clock) => {
    const files = new MemoryRecoveryFiles();
    const recovery = new MemoryRecoveryFiles();
    for (const name of ["a.md", "b.md", "c.md"])
      files.files.set(name, new TextEncoder().encode("disk"));
    const binding = await EditorBinding.open(
      JSON.stringify({
        instanceId: "checkpoint-iteration",
        vault: { vaultId: "checkpoint-vault", historyId: "checkpoint-history" },
      }),
      createBrowserIo(files),
      createBrowserIo(recovery),
      false,
    );
    const core = wasmCore(binding);
    const events: ServiceEvent[] = [];
    const host = new TestHost(
      core,
      files,
      (event) => events.push(event),
      clock.schedule,
    );
    const write = recovery.writeFile.bind(recovery);
    let attempts = 0;
    recovery.writeFile = async (...args) => {
      if (args[0].startsWith("recovery/")) attempts++;
      return write(...args);
    };
    const change = async (path: string, text: string) => {
      const document = await host.open(vaultPath(path));
      return host.apply(document.id, {
        kind: "edit",
        base: document.core!.version,
        input: { kind: "text", text },
        undo: { positions: [] },
      });
    };
    try {
      recovery.failWrites = true;
      await change("a.md", "draft a");
      await change("b.md", "draft b");
      await clock.advance(500);
      const documents = coreValue<CoreDocument[]>(
        await core.call("resident", {}),
      );
      assert.equal(documents.length, 2);
      assert.ok(documents.every((document) => document.recoveryDelay === null));
      assert.ok(documents.every((document) => document.recoveryError !== null));
      assert.equal(attempts, 2);
      // Ordinary-file autosave has its own later timer. Recovery itself must
      // leave no zero-delay work after attempting both documents.
      await clock.advance(500);
      assert.equal(attempts, 2);
      recovery.failWrites = false;
      const third = await change("c.md", "independent draft");
      await clock.advance(500);
      const drafts = [...recovery.files]
        .filter(([path]) => path.startsWith("recovery/"))
        .map(([, data]) => JSON.parse(new TextDecoder().decode(data)));
      assert.equal(
        drafts.find((draft) => draft.path === "c.md")?.text,
        "independent draft",
      );
      assert.equal(
        (await host.read(third.document.id)).core?.recoveryError,
        null,
      );
      assert.ok(
        events.some(
          (event) =>
            event.kind === "document" && event.document.core?.recoveryError,
        ),
      );
    } finally {
      host.dispose();
      binding.free();
    }
  });
});

async function localFixture(
  paths: string[],
  schedule: (task: () => Promise<unknown>) => void,
  emit: (event: ServiceEvent) => void = () => {},
  observeExternal = false,
) {
  await coreReady;
  const files = new MemoryRecoveryFiles();
  const recovery = new MemoryRecoveryFiles();
  for (const path of paths)
    files.files.set(path, new TextEncoder().encode("disk"));
  const binding = await EditorBinding.open(
    JSON.stringify({
      instanceId: crypto.randomUUID(),
      vault: { vaultId: crypto.randomUUID(), historyId: crypto.randomUUID() },
    }),
    createBrowserIo(files),
    createBrowserIo(recovery),
    observeExternal,
  );
  const core = wasmCore(binding);
  const session = new LocalEditorSession(
    core,
    files,
    emit,
    schedule,
    observeExternal,
  );
  const edit = async (path: string) => {
    const document = await session.open(vaultPath(path));
    return session.apply(document.id, {
      kind: "edit",
      base: document.core!.version,
      input: { kind: "text", text: `draft ${path}` },
      undo: { positions: [] },
    });
  };
  return { files, recovery, binding, core, session, edit };
}

test("ending composition resumes a consumed autosave for OPFS and directory owners", async () => {
  for (const observeExternal of [false, true]) {
    await withRecoveryClock(async (clock) => {
      const { files, binding, session } = await localFixture(
        ["a.md"],
        clock.schedule,
        () => {},
        observeExternal,
      );
      try {
        const document = await session.open(vaultPath("a.md"));
        await session.composition(document.id, true);
        await session.apply(document.id, {
          kind: "edit",
          base: document.core!.version,
          input: { kind: "text", text: "composition draft" },
          undo: { positions: [] },
        });
        await clock.advance(1800);
        assert.equal(new TextDecoder().decode(files.files.get("a.md")), "disk");
        await session.composition(document.id, false);
        await clock.advance(800);
        assert.equal(
          new TextDecoder().decode(files.files.get("a.md")),
          "composition draft",
        );
        const saved = await session.read(document.id);
        assert.equal(saved.savedContent, saved.content);
      } finally {
        session.dispose();
        binding.free();
      }
    });
  }
});

test("readonly file queries publish no bodies and writes deliver only their mutation", async () => {
  const events: ServiceEvent[] = [];
  const { binding, session, files } = await localFixture(
    ["a.md", "b.md", "c.md"],
    () => {},
    (event) => events.push(event),
  );
  try {
    for (const path of ["a.md", "b.md", "c.md"]) {
      files.files.set(path, new TextEncoder().encode("a".repeat(1000)));
      await session.open(vaultPath(path));
    }
    events.length = 0;
    await session.fileOperation("stat", { path: "a.md" });
    await session.fileOperation("readDir", { path: "" });
    await session.fileOperation("readFileSnapshot", { path: "a.md" });
    assert.equal(events.length, 0);
    await session.fileOperation("writeFile", {
      path: "a.md",
      data: new TextEncoder().encode("replacement"),
      options: { mode: "replace" },
    });
    const bodies = events.filter(
      (event) =>
        event.kind === "document" && event.document.content !== undefined,
    );
    assert.equal(bodies.length, 1);
    assert.equal(bodies[0].kind, "document");
    if (bodies[0].kind !== "document")
      throw new Error("missing document event");
    assert.equal(bodies[0].document.path, "a.md");
    assert.equal(bodies[0].document.content, "replacement");
  } finally {
    session.dispose();
    binding.free();
  }
});

test("slow timed and explicit recovery IO checkpoints resident drafts once", async () => {
  for (const explicit of [false, true]) {
    await withRecoveryClock(async (clock) => {
      let tail = Promise.resolve();
      let scheduled = 0;
      const { binding, session, recovery, core } = await localFixture(
        ["a.md", "b.md", "c.md"],
        (task) => {
          scheduled++;
          tail = tail.then(task).then(() => {});
        },
      );
      let release!: () => void;
      let entered!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let writes = 0;
      let checkpoints = 0;
      const call = core.call.bind(core);
      core.call = (method, params) => {
        if (method === "checkpoint") checkpoints++;
        return call(method, params);
      };
      const write = recovery.writeFile.bind(recovery);
      recovery.writeFile = async (...args) => {
        if (args[0].startsWith("recovery/")) {
          writes++;
          if (writes === 1) {
            entered();
            await gate;
          }
        }
        return write(...args);
      };
      let checkpoint: Promise<unknown> | null = null;
      try {
        let firstId = "";
        for (const path of ["a.md", "b.md", "c.md"]) {
          const document = await session.open(vaultPath(path));
          firstId ||= document.id;
          await session.apply(document.id, {
            kind: "edit",
            base: document.core!.version,
            input: { kind: "text", text: `draft ${path}` },
            undo: { positions: [] },
          });
          await session.releaseDocument(document.id);
        }
        if (explicit) checkpoint = session.checkpoint(firstId);
        await clock.advance(500);
        await started;
        await clock.advance(200);
        assert.equal(scheduled, explicit ? 0 : 1);
        assert.equal(writes, 1);
        release();
        await tail;
        await checkpoint;
        assert.equal(checkpoints, 1);
        assert.equal(writes, 3);
        const drafts = [...recovery.files]
          .filter(([path]) => path.startsWith("recovery/"))
          .map(([, bytes]) => JSON.parse(new TextDecoder().decode(bytes)));
        assert.deepEqual(drafts.map((draft) => draft.text).sort(), [
          "draft a.md",
          "draft b.md",
          "draft c.md",
        ]);
      } finally {
        release();
        await tail;
        await checkpoint;
        session.dispose();
        binding.free();
      }
    });
  }
});

test("save and conflict resolution refresh a cleared global recovery error without other bodies", async () => {
  for (const action of ["save", "resolve"] as const) {
    const events: ServiceEvent[] = [];
    const { binding, session, recovery, edit } = await localFixture(
      ["a.md", "b.md"],
      () => {},
      (event) => events.push(event),
    );
    try {
      const first = await edit("a.md");
      const second = await edit("b.md");
      recovery.failWrites = true;
      await assert.rejects(
        session.checkpoint(first.document.id),
        /write failed/,
      );
      assert.ok((await session.read(second.document.id)).core?.recoveryError);
      recovery.failWrites = false;
      events.length = 0;
      if (action === "save") await session.save(first.document.id);
      else await session.resolve(first.document.id, "overwrite");
      const other = events.filter(
        (event) =>
          event.kind === "document" && event.document.id === second.document.id,
      );
      assert.equal(other.length, 1);
      assert.equal(other[0].kind, "document");
      if (other[0].kind !== "document")
        throw new Error("missing document event");
      assert.equal(other[0].document.core?.recoveryError, null);
      assert.equal(other[0].document.content, undefined);
      assert.equal(
        (await session.read(second.document.id)).core?.recoveryError,
        null,
      );
    } finally {
      session.dispose();
      binding.free();
    }
  }
});

test("open, retry and observation propagate cleared recovery errors to composing documents", async () => {
  for (const action of ["open", "retry", "observe"] as const) {
    const events: ServiceEvent[] = [];
    const { binding, session, recovery, files, edit } = await localFixture(
      ["a.md", "b.md"],
      () => {},
      (event) => events.push(event),
      true,
    );
    try {
      const first = await edit("a.md");
      const second = await edit("b.md");
      const write = recovery.writeFile.bind(recovery);
      recovery.writeFile = async (...args) => {
        if (
          args[0].startsWith("recovery/") &&
          JSON.parse(new TextDecoder().decode(args[1])).path === "a.md"
        )
          throw new VaultError("IO", "checkpoint failed", args[0]);
        return write(...args);
      };
      await assert.rejects(
        session.checkpoint(first.document.id),
        /checkpoint failed/,
      );
      recovery.writeFile = write;
      files.files.set("a.md", new TextEncoder().encode("external disk"));
      if (action === "observe")
        await session.composition(second.document.id, true);
      events.length = 0;
      if (action === "open") await session.open(vaultPath("a.md"));
      else if (action === "retry")
        await session.retryObservation(first.document.id);
      else await session.observeFiles();
      assert.equal(
        (await session.read(second.document.id)).core?.recoveryError,
        null,
      );
      const other = events.filter(
        (event) =>
          event.kind === "document" && event.document.id === second.document.id,
      );
      assert.equal(other.length, 1);
      if (other[0].kind !== "document")
        throw new Error("missing document event");
      assert.equal(other[0].document.core?.recoveryError, null);
      assert.equal(other[0].document.content, undefined);
    } finally {
      session.dispose();
      binding.free();
    }
  }
});

test("failed open and observation retry publish new global recovery errors", async () => {
  for (const action of ["open", "retry"] as const) {
    const events: ServiceEvent[] = [];
    const { binding, session, recovery, files, edit } = await localFixture(
      ["a.md", "b.md"],
      () => {},
      (event) => events.push(event),
      true,
    );
    try {
      const other = await session.open(vaultPath("b.md"));
      let firstId = "";
      if (action === "retry") {
        firstId = (await edit("a.md")).document.id;
        files.files.set("a.md", new TextEncoder().encode("external disk"));
      }
      const remove = recovery.remove.bind(recovery);
      recovery.remove = async (path) => {
        if (path.startsWith("recovery/"))
          throw new VaultError("IO", "recovery failed", path);
        return remove(path);
      };
      const write = recovery.writeFile.bind(recovery);
      recovery.writeFile = async (...args) => {
        if (args[0].startsWith("recovery/"))
          throw new VaultError("IO", "recovery failed", args[0]);
        return write(...args);
      };
      events.length = 0;
      await assert.rejects(
        action === "open"
          ? session.open(vaultPath("a.md"))
          : session.retryObservation(firstId),
        /recovery failed/,
      );
      const metadata = events.filter(
        (event) => event.kind === "document" && event.document.id === other.id,
      );
      assert.equal(metadata.length, 1);
      if (metadata[0].kind !== "document")
        throw new Error("missing document event");
      assert.match(
        metadata[0].document.core?.recoveryError ?? "",
        /recovery failed/,
      );
      assert.equal(metadata[0].document.content, undefined);
    } finally {
      session.dispose();
      binding.free();
    }
  }
});

test("a save rejected after recovery succeeds still clears other document errors", async () => {
  const events: ServiceEvent[] = [];
  const { binding, session, files, recovery, edit } = await localFixture(
    ["a.md", "b.md"],
    () => {},
    (event) => events.push(event),
  );
  try {
    const first = await edit("a.md");
    const second = await edit("b.md");
    recovery.failWrites = true;
    await assert.rejects(session.checkpoint(first.document.id), /write failed/);
    recovery.failWrites = false;
    files.files.set("a.md", new Uint8Array(10 * 1024 * 1024 + 4));
    events.length = 0;
    await assert.rejects(session.save(first.document.id), /read limit/);
    const other = events.filter(
      (event) =>
        event.kind === "document" && event.document.id === second.document.id,
    );
    assert.equal(other.length, 1);
    assert.equal(other[0].kind, "document");
    if (other[0].kind !== "document") throw new Error("missing document event");
    assert.equal(other[0].document.core?.recoveryError, null);
    assert.equal(other[0].document.content, undefined);
  } finally {
    session.dispose();
    binding.free();
  }
});

test("disposing during a recovery write cannot recreate background timers", async () => {
  await withRecoveryClock(async (clock) => {
    let tail = Promise.resolve();
    const { binding, session, recovery, edit } = await localFixture(
      ["a.md"],
      (task) => {
        tail = tail.then(task).then(() => {});
      },
    );
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const write = recovery.writeFile.bind(recovery);
    recovery.writeFile = async (...args) => {
      if (args[0].startsWith("recovery/")) {
        entered();
        await gate;
      }
      return write(...args);
    };
    try {
      await edit("a.md");
      await clock.advance(500);
      await started;
      session.dispose();
      release();
      await tail;
      assert.equal(clock.pending(), 0);
    } finally {
      release();
      await tail;
      session.dispose();
      binding.free();
    }
  });
});
