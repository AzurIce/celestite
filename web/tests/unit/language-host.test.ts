import { test } from "node:test";
import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import { LanguageHost, type LanguageWorker } from "../../src/lib/language/host";
import type {
  LanguageWorkerReply,
  LanguageWorkerRequest,
} from "../../src/lib/language/protocol";
import { PreviewResources } from "../../src/lib/preview/resources";
import type { PreviewResource } from "../../src/lib/preview/contract";
import type { VaultBackend } from "../../src/lib/vault/types";
import { LanguageBinding } from "../../src/lib/editor/generated/celestite_core";
import { coreReady } from "./core-runtime";

class MockWorker implements LanguageWorker {
  received: LanguageWorkerRequest[] = [];
  terminated = false;
  respond?: (request: LanguageWorkerRequest, worker: MockWorker) => void;
  private messages = new Set<
    (event: MessageEvent<LanguageWorkerReply>) => void
  >();
  private errors = new Set<(event: ErrorEvent) => void>();
  postMessage(request: LanguageWorkerRequest) {
    this.received.push(request);
    if (this.respond) queueMicrotask(() => this.respond?.(request, this));
  }
  addEventListener(
    type: "message" | "error",
    listener:
      | ((event: MessageEvent<LanguageWorkerReply>) => void)
      | ((event: ErrorEvent) => void),
  ) {
    if (type === "message")
      this.messages.add(
        listener as (event: MessageEvent<LanguageWorkerReply>) => void,
      );
    else this.errors.add(listener as (event: ErrorEvent) => void);
  }
  terminate() {
    this.terminated = true;
  }
  emit(reply: LanguageWorkerReply) {
    for (const listener of this.messages)
      listener({ data: reply } as MessageEvent<LanguageWorkerReply>);
  }
  crash() {
    for (const listener of this.errors)
      listener(new Event("error") as ErrorEvent);
  }
}

function fixture(
  respond?: MockWorker["respond"],
  resources?: PreviewResources,
) {
  const workers: MockWorker[] = [];
  const emitted: string[] = [];
  const inputs = resources ?? new PreviewResources({} as VaultBackend);
  const host = new LanguageHost(
    inputs,
    (message) => emitted.push(message),
    () => {
      const worker = new MockWorker();
      worker.respond = respond;
      workers.push(worker);
      return worker;
    },
  );
  return {
    host,
    resources: inputs,
    workers,
    emitted,
    /** Deliver every queued item through the mocked worker. */
    async flush() {
      for (let i = 0; i < 10; i++) await nextTurn();
    },
  };
}

const doneOnArrival: MockWorker["respond"] = (request, worker) => {
  if (request.kind !== "resources")
    worker.emit({ kind: "done", id: request.id });
};

test("notifications wait for a trailing debounce; requests flush in order", async () => {
  const originalTimeout = globalThis.setTimeout;
  let debounce: (() => void) | undefined;
  globalThis.setTimeout = ((
    callback: (...args: unknown[]) => void,
    delay?: number,
    ...args: unknown[]
  ) => {
    if (delay === 150) {
      debounce = () => callback();
      return originalTimeout(() => {}, 0);
    }
    return originalTimeout(callback, delay, ...args);
  }) as typeof globalThis.setTimeout;
  const { host, workers } = fixture(doneOnArrival);
  try {
    const opened = JSON.stringify({
      jsonrpc: "2.0",
      method: "textDocument/didOpen",
      params: { textDocument: { uri: "file:///vault/a.not", text: "x" } },
    });
    const changed = JSON.stringify({
      jsonrpc: "2.0",
      method: "textDocument/didChange",
      params: {
        textDocument: { uri: "file:///vault/a.not" },
        contentChanges: [{ text: "y" }],
      },
    });
    const hover = JSON.stringify({
      jsonrpc: "2.0",
      id: 7,
      method: "textDocument/hover",
      params: {},
    });
    host.handle(opened);
    host.handle(changed);
    await nextTurn();
    // Notifications alone never reach the worker before the debounce fires.
    assert.equal(workers.length, 0);
    assert.equal(typeof debounce, "function");
    host.handle(hover);
    // The request flushes immediately, taking the queued notifications along.
    await nextTurn();
    await nextTurn();
    assert.equal(workers.length, 1);
    assert.deepEqual(
      workers[0].received.map((request) =>
        request.kind === "message" ? request.message : request.kind,
      ),
      [opened, changed, hover],
    );
    await nextTurn();
  } finally {
    globalThis.setTimeout = originalTimeout;
    host.dispose();
  }
});

test("the debounce timer delivers queued notifications on its own", async () => {
  const originalTimeout = globalThis.setTimeout;
  let debounce: (() => void) | undefined;
  globalThis.setTimeout = ((
    callback: (...args: unknown[]) => void,
    delay?: number,
    ...args: unknown[]
  ) => {
    if (delay === 150) {
      debounce = () => callback();
      return originalTimeout(() => {}, 0);
    }
    return originalTimeout(callback, delay, ...args);
  }) as typeof globalThis.setTimeout;
  const { host, workers } = fixture(doneOnArrival);
  try {
    const message = JSON.stringify({
      jsonrpc: "2.0",
      method: "initialized",
      params: {},
    });
    host.handle(message);
    await nextTurn();
    assert.equal(workers.length, 0);
    debounce!();
    await nextTurn();
    await nextTurn();
    assert.equal(workers.length, 1);
    assert.deepEqual(workers[0].received, [
      { kind: "message", id: 1, root: "/vault", message },
    ]);
  } finally {
    globalThis.setTimeout = originalTimeout;
    host.dispose();
  }
});

test("resource requests are read through PreviewResources and answered", async () => {
  const reads: string[] = [];
  const contexts: unknown[] = [];
  const context = {
    documentPath: "notes/a.not",
    source: "unsaved import",
    overlays: { "lib.notc": "unsaved declaration" },
  };
  const resources = new PreviewResources({} as VaultBackend);
  const answer: PreviewResource = { kind: "file", data: [65], error: null };
  resources.read = async (request, actualContext) => {
    reads.push(request.path);
    contexts.push(actualContext);
    return answer;
  };
  const { host, workers, emitted, flush } = fixture((request, worker) => {
    if (request.kind === "message") {
      worker.emit({
        kind: "resources",
        id: request.id,
        requests: [
          { path: "Notist.toml", read: true },
          { path: "a.not", read: true },
        ],
        context,
      });
      return;
    }
    if (request.kind === "resources") {
      assert.deepEqual(request.resources, {
        "Notist.toml": answer,
        "a.not": answer,
      });
      worker.emit({
        kind: "messages",
        id: request.id,
        messages: ['{"jsonrpc":"2.0","id":1,"result":null}'],
      });
      worker.emit({ kind: "done", id: request.id });
    }
  }, resources);
  try {
    host.handle(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "shutdown" }));
    await flush();
    assert.deepEqual(reads.sort(), ["Notist.toml", "a.not"]);
    assert.deepEqual(contexts, [context, context]);
    assert.deepEqual(emitted, ['{"jsonrpc":"2.0","id":1,"result":null}']);
    assert.equal(
      workers[0].received.filter((request) => request.kind === "resources")
        .length,
      1,
    );
  } finally {
    host.dispose();
  }
});

test("worker errors reject active and queued requests before the next input retries", async () => {
  const { host, workers, emitted, flush } = fixture((request, worker) => {
    if (request.kind === "message" && request.message.includes("broken"))
      worker.emit({ kind: "error", id: request.id, message: "boom" });
    else if (request.kind === "message")
      worker.emit({ kind: "done", id: request.id });
  });
  try {
    host.handle('{"jsonrpc":"2.0","id":1,"method":"broken"}');
    host.handle('{"jsonrpc":"2.0","id":2,"method":"shutdown"}');
    await flush();
    assert.equal(workers.length, 1);
    assert.equal(workers[0].received.length, 1);
    assert.equal(workers[0].terminated, true);
    assert.deepEqual(
      emitted
        .map((raw) => JSON.parse(raw))
        .map((message) => [message.id, message.error.code]),
      [
        [1, -32603],
        [2, -32603],
      ],
    );
  } finally {
    host.dispose();
  }
});

test("a worker crash terminates it and the next message respawns lazily", async () => {
  const { host, workers, flush } = fixture(doneOnArrival);
  try {
    host.handle('{"jsonrpc":"2.0","id":1,"method":"shutdown"}');
    await nextTurn();
    assert.equal(workers.length, 1);
    workers[0].crash();
    assert.equal(workers[0].terminated, true);
    await flush();
    host.handle('{"jsonrpc":"2.0","id":2,"method":"shutdown"}');
    await flush();
    assert.equal(workers.length, 2);
    assert.deepEqual(workers[1].received, [
      {
        kind: "message",
        id: 2,
        root: "/vault",
        message: '{"jsonrpc":"2.0","id":2,"method":"shutdown"}',
      },
    ]);
  } finally {
    host.dispose();
  }
});

test("dispose terminates the worker and drops in-flight replies", async () => {
  const { host, workers, emitted } = fixture();
  try {
    host.handle('{"jsonrpc":"2.0","id":1,"method":"shutdown"}');
    await nextTurn();
    assert.equal(workers.length, 1);
    host.dispose();
    assert.equal(workers[0].terminated, true);
    workers[0].emit({ kind: "messages", id: 1, messages: ["late"] });
    workers[0].emit({ kind: "done", id: 1 });
    await nextTurn();
    assert.deepEqual(emitted, []);
    host.handle('{"jsonrpc":"2.0","id":2,"method":"shutdown"}');
    await nextTurn();
    assert.equal(workers.length, 1);
  } finally {
    host.dispose();
  }
});

test("invalidate drops the snapshot and replays a watched-files refresh", async () => {
  const { host, workers, flush } = fixture(doneOnArrival);
  try {
    host.invalidate();
    await flush();
    assert.equal(workers.length, 1);
    assert.deepEqual(
      workers[0].received.map((request) =>
        request.kind === "message"
          ? JSON.parse(request.message).method
          : "invalidate",
      ),
      ["invalidate", "workspace/didChangeWatchedFiles"],
    );
  } finally {
    host.dispose();
  }
});

/** Keep Worker delivery controllable while running the production Rust service. */
async function wasmFixture(
  hold?: (request: LanguageWorkerRequest) => boolean,
  resources?: PreviewResources,
) {
  await coreReady;
  const bindings = new Map<MockWorker, LanguageBinding>();
  const result = fixture(
    (request, worker) => {
      if (hold?.(request)) return;
      let binding = bindings.get(worker);
      if (!binding) {
        assert.notEqual(request.kind, "resources");
        binding = new LanguageBinding(
          request.kind === "resources" ? "/vault" : request.root,
        );
        bindings.set(worker, binding);
      }
      if (request.kind === "invalidate") {
        binding.invalidate_resources();
        worker.emit({ kind: "done", id: request.id });
        return;
      }
      const step =
        request.kind === "message"
          ? binding.handle(request.message)
          : binding.provide({ resources: request.resources });
      if (step.messages.length)
        worker.emit({
          kind: "messages",
          id: request.id,
          messages: step.messages,
        });
      if (step.resourceRequests.length) {
        worker.emit({
          kind: "resources",
          id: request.id,
          requests: step.resourceRequests,
          context: step.context!,
        });
      } else worker.emit({ kind: "done", id: request.id });
    },
    resources ??
      new PreviewResources({
        stat: async () => null,
      } as unknown as VaultBackend),
  );
  return {
    ...result,
    send(method: string, params: unknown = {}, id?: number) {
      result.host.handle(
        JSON.stringify({
          jsonrpc: "2.0",
          method,
          params,
          ...(id === undefined ? {} : { id }),
        }),
      );
    },
    replies() {
      return result.emitted.map((raw) => JSON.parse(raw));
    },
    dispose() {
      result.host.dispose();
      for (const binding of bindings.values()) binding.free();
    },
  };
}

test("crash recovery handshakes and reopens latest queued text without reopening closed files", async () => {
  const test = await wasmFixture(
    (request) =>
      request.kind === "message" && JSON.parse(request.message).id === 3,
  );
  const uri = "file:///vault/a.notc";
  const closed = "file:///vault/b.notc";
  try {
    test.send("initialize", {}, 1);
    test.send("textDocument/didOpen", {
      textDocument: {
        uri,
        text: "fn old() -> BlockContent;",
        languageId: "notist",
        version: 1,
      },
    });
    test.send("textDocument/didOpen", {
      textDocument: { uri: closed, text: "fn broken(", version: 1 },
    });
    test.send("textDocument/documentSymbol", { textDocument: { uri } }, 2);
    await test.flush();
    test.send(
      "textDocument/hover",
      { textDocument: { uri }, position: { line: 0, character: 4 } },
      3,
    );
    test.send("textDocument/didChange", {
      textDocument: { uri, version: 2 },
      contentChanges: [{ text: "fn changed() -> BlockContent;" }],
    });
    test.send("textDocument/didClose", { textDocument: { uri: closed } });
    test.send("textDocument/documentSymbol", { textDocument: { uri } }, 4);
    test.workers[0].crash();
    await test.flush();
    assert.deepEqual(
      test
        .replies()
        .filter((message) => message.error)
        .map((message) => message.id),
      [3, 4],
    );
    assert.equal(test.workers.length, 1, "a crash does not start a retry loop");
    test.send("textDocument/documentSymbol", { textDocument: { uri } }, 5);
    await test.flush();
    assert.equal(test.workers.length, 2);
    const restored = test.workers[1].received
      .filter((request) => request.kind === "message")
      .map((request) => JSON.parse(request.message));
    assert.deepEqual(
      restored.map((message) => message.method),
      [
        "initialize",
        "initialized",
        "textDocument/didOpen",
        "textDocument/documentSymbol",
      ],
    );
    assert.deepEqual(restored[2].params.textDocument, {
      uri,
      text: "fn changed() -> BlockContent;",
      languageId: "notist",
      version: 2,
    });
    assert.equal(
      test.replies().find((message) => message.id === 5)?.result[0].name,
      "changed",
    );
    assert.equal(
      test.replies().filter((message) => typeof message.id === "string").length,
      0,
      "internal initialize replies stay inside the host",
    );
    const count = test.emitted.length;
    test.workers[0].emit({
      kind: "messages",
      id: test.workers[1].received.at(-1)!.id,
      messages: ["late"],
    });
    test.workers[0].crash();
    await test.flush();
    assert.equal(test.emitted.length, count);
    assert.equal(test.workers[1].terminated, false);
  } finally {
    test.dispose();
  }
});

test("a newly granted resource root rebuilds and restores the language service", async () => {
  const test = await wasmFixture();
  const uri = "file:///vault/a.notc";
  try {
    test.send("initialize", {}, 1);
    test.send("textDocument/didOpen", {
      textDocument: { uri, text: "fn restored() -> BlockContent;", version: 1 },
    });
    test.send("textDocument/documentSymbol", { textDocument: { uri } }, 2);
    await test.flush();
    test.resources.setPackages({
      root: "/workspace/project/vault",
      read: async () => ({ kind: null, data: null, error: null }),
      readDir: async () => [],
    });
    test.host.invalidate();
    await test.flush();
    assert.equal(test.workers.length, 2);
    assert.equal(test.workers[0].terminated, true);
    const messages = test.workers[1].received.filter(
      (request) => request.kind === "message",
    );
    assert.equal(messages[0].root, "/workspace/project/vault");
    assert.deepEqual(
      messages.map((request) => JSON.parse(request.message).method),
      [
        "initialize",
        "initialized",
        "textDocument/didOpen",
        "workspace/didChangeWatchedFiles",
      ],
    );
    test.send("textDocument/documentSymbol", { textDocument: { uri } }, 3);
    await test.flush();
    assert.equal(
      test.replies().find((message) => message.id === 3)?.result[0].name,
      "restored",
    );
  } finally {
    test.dispose();
  }
});

test("changing resource roots cancels in-flight batches before any read can cross providers", async () => {
  const reads: { stage: string; path: string }[] = [];
  const gates: (() => void)[] = [];
  const provider = (root: string, stage: string) => ({
    root,
    async read(request: { path: string }) {
      reads.push({ stage, path: request.path });
      if (stage === "old")
        await new Promise<void>((resolve) => gates.push(resolve));
      // A stale old-root request would deliberately receive a different module.
      const source =
        stage === "new" && request.path.startsWith("/workspace/widgets/")
          ? "fn wrong() -> BlockContent;"
          : "fn panel() -> BlockContent;";
      return {
        kind: "file" as const,
        data: Array.from(new TextEncoder().encode(source)),
        error: null,
      };
    },
    readDir: async () => [],
  });
  const resources = new PreviewResources(
    { stat: async () => null } as unknown as VaultBackend,
    provider("/workspace/vault", "old"),
  );
  const test = await wasmFixture(undefined, resources);
  const uri = "file:///vault/a.not";
  const source =
    Array.from(
      { length: 9 },
      (_, index) => `#import "../widgets/m${index}.notc" as m${index};`,
    ).join("\n") + "\n\n#m8.panel()\n";
  try {
    test.send("initialize", {}, 1);
    test.send("textDocument/didOpen", {
      textDocument: { uri, version: 1, text: source },
    });
    test.send("textDocument/documentSymbol", { textDocument: { uri } }, 2);
    for (let i = 0; i < 100 && gates.length < 8; i++) await nextTurn();
    assert.equal(
      gates.length,
      8,
      "the first batch is still reading the old provider",
    );
    resources.setPackages(provider("/workspace/repo/vault", "new"));
    test.host.invalidate();
    assert.equal(
      test.workers[0].terminated,
      true,
      "invalidate retires the old exchange immediately",
    );
    for (const release of gates) release();
    await test.flush();
    assert.equal(reads.filter((read) => read.stage === "old").length, 8);
    const freshReads = reads.filter((read) => read.stage === "new");
    assert.ok(freshReads.length >= 9);
    assert.ok(
      freshReads.every((read) =>
        read.path.startsWith("/workspace/repo/widgets/"),
      ),
      "no old absolute identity reaches the newly granted provider",
    );
    const diagnostics = test
      .replies()
      .filter(
        (message) =>
          message.method === "textDocument/publishDiagnostics" &&
          message.params.uri === uri,
      );
    assert.ok(diagnostics.length > 0);
    assert.ok(
      diagnostics.every((message) => message.params.diagnostics.length === 0),
      "old reads cannot publish mixed-snapshot diagnostics",
    );
    assert.equal(
      test.replies().filter((message) => message.id === 2 && message.error)
        .length,
      1,
    );
    test.send("textDocument/documentSymbol", { textDocument: { uri } }, 3);
    await test.flush();
    assert.ok(
      Array.isArray(test.replies().find((message) => message.id === 3)?.result),
    );
  } finally {
    for (const release of gates) release();
    test.dispose();
  }
});

test("startup and bootstrap failures settle requests and wait for new input", async () => {
  let attempts = 0;
  const emitted: string[] = [];
  const workers: MockWorker[] = [];
  const host = new LanguageHost(
    new PreviewResources({} as VaultBackend),
    (message) => emitted.push(message),
    () => {
      attempts++;
      if (attempts === 1) throw new Error("could not create Worker");
      const worker = new MockWorker();
      worker.respond = (request, owner) => {
        if (request.kind === "message") {
          const message = JSON.parse(request.message);
          if (typeof message.id === "string") {
            owner.emit({
              kind: "error",
              id: request.id,
              message: "WASM startup failed",
            });
            return;
          }
          owner.emit({
            kind: "messages",
            id: request.id,
            messages: [
              JSON.stringify({
                jsonrpc: "2.0",
                id: message.id,
                result: { capabilities: {} },
              }),
            ],
          });
        }
        owner.emit({ kind: "done", id: request.id });
      };
      workers.push(worker);
      return worker;
    },
  );
  try {
    host.handle('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}');
    await nextTurn();
    assert.equal(attempts, 1);
    assert.equal(
      JSON.parse(emitted[0]).error.message,
      "could not create Worker",
    );
    host.handle(
      '{"jsonrpc":"2.0","id":2,"method":"textDocument/hover","params":{}}',
    );
    for (let i = 0; i < 10; i++) await nextTurn();
    assert.equal(attempts, 2);
    assert.equal(JSON.parse(emitted[1]).id, 2);
    assert.equal(JSON.parse(emitted[1]).error.message, "WASM startup failed");
    assert.equal(workers[0].terminated, true);
    await nextTurn();
    assert.equal(attempts, 2, "a failed recovery does not retry on its own");
    host.handle('{"jsonrpc":"2.0","id":3,"method":"initialize","params":{}}');
    for (let i = 0; i < 10; i++) await nextTurn();
    assert.equal(attempts, 3);
    assert.equal(JSON.parse(emitted[2]).id, 3);
    assert.deepEqual(JSON.parse(emitted[2]).result, { capabilities: {} });
  } finally {
    host.dispose();
  }
});

test("repeated full-text edits stay coalesced while a worker is busy", async () => {
  const { host, workers, flush } = fixture();
  try {
    host.handle('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}');
    for (let i = 0; i < 1000; i++)
      host.handle(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "textDocument/didChange",
          params: {
            textDocument: { uri: "file:///vault/a.not" },
            contentChanges: [{ text: String(i) }],
          },
        }),
      );
    workers[0].respond = doneOnArrival;
    workers[0].emit({ kind: "done", id: workers[0].received[0].id });
    await flush();
    assert.equal(workers.length, 1);
    assert.equal(workers[0].received.length, 2);
    const change = workers[0].received[1];
    assert.equal(change.kind, "message");
    if (change.kind === "message")
      assert.equal(
        JSON.parse(change.message).params.contentChanges[0].text,
        "999",
      );
  } finally {
    host.dispose();
  }
});

test("an overflowing request queue settles all affected requests", async () => {
  const { host, workers, emitted, flush } = fixture();
  try {
    for (let id = 1; id <= 300; id++)
      host.handle(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          method: "textDocument/hover",
          params: {},
        }),
      );
    await flush();
    assert.equal(workers[0].terminated, true);
    assert.equal(workers.length, 2);
    workers[1].crash();
    await flush();
    const replies = emitted.map((raw) => JSON.parse(raw));
    assert.equal(replies.length, 300);
    assert.equal(new Set(replies.map((message) => message.id)).size, 300);
    assert.ok(replies.every((message) => message.error.code === -32603));
  } finally {
    host.dispose();
  }
});
