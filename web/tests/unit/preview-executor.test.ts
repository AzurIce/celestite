import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import init, {
  EditorBinding,
  BufferBinding,
  PreviewBinding,
} from "../../src/lib/editor/generated/celestite_core";
import { PreviewHost } from "../../src/lib/preview/host";
import type { PreviewResources } from "../../src/lib/preview/resources";
import type {
  PreviewTask,
  PreviewCompletion,
  PreviewExecutor,
  PreviewResourceReader,
  PreviewResource,
} from "../../src/lib/preview/contract";
import { browserPreviewExecutor } from "../../src/lib/preview/browser-executor";
import type {
  PreviewWorkerRequest,
  PreviewWorkerReply,
} from "../../src/lib/preview/worker-protocol";
import { wasmCore } from "../../src/lib/editor/core";
import { PreviewResources as Resources } from "../../src/lib/preview/resources";
import { EditorSession } from "../../src/lib/editor/runtime/session";
import type { VaultBackend } from "../../src/lib/vault/types";

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const success = (task: PreviewTask): PreviewCompletion => ({
  taskId: task.ticket.taskId,
  outcome: { kind: "success", output: { html: task.source, diagnostics: [] } },
});
const task = (taskId: string): PreviewTask => ({
  ticket: {
    taskId,
    documentId: "doc",
    sessionId: "session",
    path: "a.not",
    renderGeneration: "generation",
    version: {
      identity: { document_id: "doc", history_id: "history" },
      clocks: {},
    },
  },
  source: "hello",
});

class Executor implements PreviewExecutor {
  tasks: PreviewTask[] = [];
  terminated = false;
  result = deferred<PreviewCompletion>();
  signal?: AbortSignal;
  read!: PreviewResourceReader;
  execute(task: PreviewTask, read: PreviewResourceReader, signal: AbortSignal) {
    this.tasks.push(task);
    this.signal = signal;
    this.read = read;
    // Deliberately ignores cancellation so the host must reject late results.
    return this.result.promise;
  }
  dispose() {
    this.terminated = true;
  }
}

class SourceEditor extends EditorSession {
  replaceSource(documents: unknown[]) {
    return this.execute("replica_session", { documents });
  }
}

test("environment invalidation releases the external controller task before terminating its executor", async () => {
  await init({
    module_or_path: await readFile(
      new URL(
        "../../src/lib/editor/generated/celestite_core_bg.wasm",
        import.meta.url,
      ),
    ),
  });
  const core = await EditorBinding.memory(
    JSON.stringify({
      instanceId: "preview-executor",
      vault: { vaultId: "vault", historyId: "history" },
    }),
  );
  const seed = new BufferBinding(
    JSON.stringify({ document_id: "doc", history_id: "history" }),
    "1",
    "text",
  );
  const call = async (method: string, params: object) => {
    const reply = JSON.parse(await core.call(method, JSON.stringify(params)));
    if (reply.status === "error") throw new Error(reply.error.message);
    return reply.value;
  };
  await call("join", {
    path: "a.not",
    packet: JSON.parse(seed.export_snapshot()),
  });
  const binding = new PreviewBinding();
  const reads: string[][] = [];
  const editor = new SourceEditor(wasmCore(core), () => {});
  const executors: Executor[] = [];
  const host = new PreviewHost(
    (ids, consume) => {
      reads.push([...ids]);
      return editor.withSource(ids, consume);
    },
    binding,
    () => {},
    () => {},
    { root: "/vault" } as PreviewResources,
    () => {
      const executor = new Executor();
      executors.push(executor);
      return executor;
    },
  );
  try {
    await host.subscribe("doc", "client");
    await host.refresh();
    const first = executors[0].tasks[0];
    assert.equal(first.source, "text");
    assert.ok(reads.some((ids) => ids.length === 0));
    assert.ok(reads.some((ids) => ids.includes("doc")));
    await host.invalidateProject();
    assert.equal(executors[0].terminated, true);
    await host.retry("doc");
    await host.refresh();
    assert.notEqual(executors[1].tasks[0].ticket.taskId, first.ticket.taskId);
    const oldEpoch = executors[1].tasks[0];
    const captured = await editor.readSource(["doc"]);
    await editor.replaceSource([
      {
        packets: [JSON.parse(seed.export_snapshot())],
        state: {
          path: "a.not",
          version: captured.documents[0].version,
          savedContent: "text",
          fileRevision: "",
          bom: false,
          lineEnding: "\n",
          deleted: false,
          conflict: false,
          error: null,
        },
      },
    ]);
    await host.refresh();
    assert.equal(executors[1].terminated, true);
    assert.notEqual(
      executors[2].tasks[0].ticket.taskId,
      oldEpoch.ticket.taskId,
    );
    assert.equal(executors[1].signal?.aborted, true);
    executors[1].result.resolve(success(oldEpoch));
    await settle();
    assert.equal(binding.state("doc").result, null);
  } finally {
    await host.close();
    seed.free();
    core.free();
  }
});

class WorkerTransport extends EventTarget {
  messages: PreviewWorkerRequest[] = [];
  terminated = false;
  postMessage(message: PreviewWorkerRequest) {
    this.messages.push(message);
  }
  terminate() {
    this.terminated = true;
  }
  reply(data: PreviewWorkerReply) {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
}

test("browser execution reuses its initialized Worker and isolates old task replies", async () => {
  const workers: WorkerTransport[] = [];
  const executor = browserPreviewExecutor(() => {
    const worker = new WorkerTransport();
    workers.push(worker);
    return worker;
  });
  const resources: Record<string, PreviewResource> = {
    "a.not": { kind: "file", data: [65], error: null },
  };
  const read: PreviewResourceReader = async (requests) => {
    assert.deepEqual(requests, [{ path: "a.not", read: true }]);
    return resources;
  };
  try {
    const first = task("first");
    const result = executor.execute(first, read, new AbortController().signal);
    workers[0].reply({
      kind: "resources",
      taskId: "first",
      requests: [{ path: "a.not", read: true }],
    });
    await settle();
    assert.deepEqual(workers[0].messages[1], {
      kind: "resources",
      taskId: "first",
      resources,
    });
    workers[0].reply({ kind: "complete", completion: success(first) });
    assert.deepEqual(await result, success(first));
    const second = task("second");
    let completed = false;
    const next = executor
      .execute(second, read, new AbortController().signal)
      .then((value) => {
        completed = true;
        return value;
      });
    workers[0].reply({ kind: "complete", completion: success(first) });
    await settle();
    assert.equal(completed, false);
    assert.equal(workers.length, 1);
    assert.equal(workers[0].terminated, false);
    workers[0].reply({ kind: "complete", completion: success(second) });
    assert.deepEqual(await next, success(second));
  } finally {
    executor.dispose?.();
  }
  assert.equal(workers[0].terminated, true);
});

test("aborting a browser resource request drops its late reply and rebuilds the Worker", async () => {
  const workers: WorkerTransport[] = [];
  const executor = browserPreviewExecutor(() => {
    const worker = new WorkerTransport();
    workers.push(worker);
    return worker;
  });
  const resources = deferred<Record<string, PreviewResource>>();
  const abort = new AbortController();
  const result = executor.execute(
    task("cancelled"),
    () => resources.promise,
    abort.signal,
  );
  workers[0].reply({
    kind: "resources",
    taskId: "cancelled",
    requests: [{ path: "a.not", read: true }],
  });
  await settle();
  abort.abort();
  await assert.rejects(result, { name: "AbortError" });
  resources.resolve({});
  await settle();
  assert.equal(workers[0].messages.length, 1);
  assert.equal(workers[0].terminated, true);
  const next = task("next");
  const result2 = executor.execute(
    next,
    async () => ({}),
    new AbortController().signal,
  );
  assert.equal(workers.length, 2);
  workers[1].reply({ kind: "complete", completion: success(next) });
  await result2;
  executor.dispose?.();
});

test("browser error and messageerror reject execution and release the broken Worker", async () => {
  const workers: WorkerTransport[] = [];
  const executor = browserPreviewExecutor(() => {
    const worker = new WorkerTransport();
    workers.push(worker);
    return worker;
  });
  for (const [index, event, expected] of [
    [0, "error", /无法启动/],
    [1, "messageerror", /无法读取/],
  ] as const) {
    const result = executor.execute(
      task(String(index)),
      async () => ({}),
      new AbortController().signal,
    );
    workers[index].dispatchEvent(new Event(event));
    await assert.rejects(result, expected);
    assert.equal(workers[index].terminated, true);
  }
  executor.dispose?.();
});

test("browser startup and resource IO failures reject without leaving a busy executor", async () => {
  let failStartup = true;
  const worker = new WorkerTransport();
  const executor = browserPreviewExecutor(() => {
    if (failStartup) {
      failStartup = false;
      throw new Error("Worker unavailable");
    }
    return worker;
  });
  await assert.rejects(
    executor.execute(
      task("startup"),
      async () => ({}),
      new AbortController().signal,
    ),
    /Worker unavailable/,
  );
  const result = executor.execute(
    task("resources"),
    async () => {
      throw new Error("resource unavailable");
    },
    new AbortController().signal,
  );
  worker.reply({
    kind: "resources",
    taskId: "resources",
    requests: [{ path: "a.not", read: true }],
  });
  await assert.rejects(result, /resource unavailable/);
  assert.equal(worker.terminated, true);
  executor.dispose?.();
});

test("cancelling component assets never continues from a pending directory read", async () => {
  const entries = deferred<{ path: string; kind: string }[]>();
  let reads = 0;
  const resources = new Resources({} as VaultBackend, {
    root: "/vault",
    readDir: () => entries.promise,
    async read() {
      reads++;
      return { kind: "file", data: [65], error: null };
    },
  });
  const abort = new AbortController();
  const result = resources.assets(
    { ...task("assets"), overlays: { "/pkg/a/index.js": "// captured entry" } },
    [
      {
        package: "pkg",
        name: "a",
        packageRoot: "/pkg",
        path: "/pkg/a/index.js",
        tag: "pkg-a",
      },
    ],
    abort.signal,
  );
  abort.abort();
  entries.resolve([{ path: "/pkg/a/index.js", kind: "file" }]);
  await assert.rejects(result, { name: "AbortError" });
  assert.equal(reads, 0);
});
