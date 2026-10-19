import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setImmediate as nextTurn } from "node:timers/promises";
import init, {
  BufferBinding,
  EditorBinding,
  PreviewBinding,
} from "../../src/lib/editor/generated/celestite_core";
import { wasmCore } from "../../src/lib/editor/core";
import { EditorSession } from "../../src/lib/editor/runtime/session";
import { PreviewHost } from "../../src/lib/preview/host";
import { PreviewResources } from "../../src/lib/preview/resources";
import type {
  PreviewCompletion,
  PreviewComponent,
  PreviewEvent,
  PreviewExecutor,
  PreviewResource,
  PreviewResourceReader,
  PreviewTask,
} from "../../src/lib/preview/contract";
import type { VaultBackend } from "../../src/lib/vault/types";

const ready = readFile(
  new URL(
    "../../src/lib/editor/generated/celestite_core_bg.wasm",
    import.meta.url,
  ),
).then((bytes) => init({ module_or_path: bytes }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

class Executor implements PreviewExecutor {
  task!: PreviewTask;
  read!: PreviewResourceReader;
  signal!: AbortSignal;
  disposed = false;
  result = deferred<PreviewCompletion>();
  execute(task: PreviewTask, read: PreviewResourceReader, signal: AbortSignal) {
    this.task = task;
    this.read = read;
    this.signal = signal;
    // Late completions remain possible even after the host cancels this executor.
    return this.result.promise;
  }
  dispose() {
    this.disposed = true;
  }
}

const component: PreviewComponent = {
  package: "pkg",
  name: "panel",
  tag: "pkg-panel",
  packageRoot: "/pkg",
  path: "/pkg/components/panel.js",
};
const success = (
  task: PreviewTask,
  components: PreviewComponent[] = [],
): PreviewCompletion => ({
  taskId: task.ticket.taskId,
  outcome: {
    kind: "success",
    output: { html: task.source, diagnostics: [], usedComponents: components },
  },
});

async function openHost(resources: PreviewResources) {
  await ready;
  const core = await EditorBinding.memory(
    JSON.stringify({
      instanceId: crypto.randomUUID(),
      vault: { vaultId: "vault", historyId: "history" },
    }),
  );
  const seed = new BufferBinding(
    JSON.stringify({ document_id: "doc", history_id: "history" }),
    "1",
    "text",
  );
  const joined = JSON.parse(
    await core.call(
      "join",
      JSON.stringify({
        path: "a.not",
        packet: JSON.parse(seed.export_snapshot()),
      }),
    ),
  );
  assert.equal(joined.status, "ok");
  const editor = new EditorSession(wasmCore(core), () => {});
  const binding = new PreviewBinding();
  const completions: PreviewCompletion[] = [];
  const complete = binding.complete.bind(binding);
  binding.complete = (completion) => {
    completions.push(completion);
    return complete(completion);
  };
  const events: PreviewEvent[] = [];
  const scheduled: (() => Promise<unknown>)[] = [];
  const executors: Executor[] = [];
  const host = new PreviewHost(
    (ids, consume) => editor.withSource(ids, consume),
    binding,
    (event) => events.push(event),
    (work) => {
      scheduled.push(work);
    },
    resources,
    () => {
      const executor = new Executor();
      executors.push(executor);
      return executor;
    },
  );
  await host.subscribe("doc", "client");
  await host.refresh();
  assert.equal(executors.length, 1);
  return {
    host,
    binding,
    completions,
    events,
    executors,
    async flush() {
      await nextTurn();
      while (scheduled.length) await scheduled.shift()!();
    },
    async close() {
      await host.close();
      seed.free();
      core.free();
    },
  };
}

function pendingAssets() {
  const entered = deferred<void>();
  const entries = deferred<{ path: string; kind: string }[]>();
  const directories: string[] = [];
  let fileReads = 0;
  const resources = new PreviewResources({} as VaultBackend, {
    root: "/vault",
    readDir(path) {
      directories.push(path);
      entered.resolve(undefined);
      return entries.promise;
    },
    async read() {
      fileReads++;
      return { kind: "file", data: [65], error: null };
    },
  });
  return {
    resources,
    entered,
    directories,
    get fileReads() {
      return fileReads;
    },
    release() {
      entries.resolve([
        { path: "/pkg/components/nested", kind: "directory" },
        { path: component.path, kind: "file" },
      ]);
    },
  };
}

test("host bounds resource IO to eight readers and discards pending reads after retry", async () => {
  const pending = new Map<
    string,
    ReturnType<typeof deferred<PreviewResource>>
  >();
  const started: string[] = [];
  let active = 0;
  let peak = 0;
  const resources = new PreviewResources({} as VaultBackend);
  resources.read = async (request) => {
    started.push(request.path);
    peak = Math.max(peak, ++active);
    const read = deferred<PreviewResource>();
    pending.set(request.path, read);
    try {
      return await read.promise;
    } finally {
      active--;
    }
  };
  const fixture = await openHost(resources);
  try {
    const executor = fixture.executors[0];
    const requests = Array.from({ length: 24 }, (_, i) => ({
      path: `${i}.not`,
      read: true,
    }));
    const reading = executor.read(requests);
    const rejected = assert.rejects(reading, { name: "AbortError" });
    assert.equal(started.length, 8);
    assert.equal(active, 8);
    const resource: PreviewResource = { kind: "file", data: [65], error: null };
    pending.get("0.not")!.resolve(resource);
    await nextTurn();
    assert.equal(started.length, 9);
    assert.equal(active, 8);
    assert.equal(peak, 8);
    assert.deepEqual(executor.task.resources?.["0.not"], resource);
    const accepted = structuredClone(executor.task.resources);
    await fixture.host.retry("doc");
    assert.equal(executor.signal.aborted, true);
    assert.equal(executor.disposed, true);
    for (const read of pending.values()) read.resolve(resource);
    await rejected;
    await nextTurn();
    assert.equal(started.length, 9);
    assert.equal(active, 0);
    assert.deepEqual(executor.task.resources, accepted);
    assert.equal(fixture.binding.state("doc").status, "pending");
    const count = fixture.completions.length;
    executor.result.resolve(success(executor.task));
    await fixture.flush();
    assert.equal(fixture.completions.length, count);
    assert.equal(fixture.binding.state("doc").result, null);
  } finally {
    await fixture.close();
  }
});

for (const cancellation of ["retry", "close"] as const) {
  test(`host ${cancellation} cancels component collection before another IO or late completion`, async () => {
    const assets = pendingAssets();
    const fixture = await openHost(assets.resources);
    try {
      const executor = fixture.executors[0];
      executor.result.resolve(success(executor.task, [component]));
      await assets.entered.promise;
      assert.deepEqual(assets.directories, ["/pkg/components"]);
      if (cancellation === "retry") await fixture.host.retry("doc");
      else await fixture.host.close();
      assert.equal(executor.signal.aborted, true);
      assert.equal(executor.disposed, true);
      const completed = fixture.completions.length;
      const emitted = fixture.events.length;
      assets.release();
      await fixture.flush();
      assert.equal(assets.fileReads, 0);
      assert.deepEqual(assets.directories, ["/pkg/components"]);
      assert.equal(fixture.completions.length, completed);
      assert.equal(fixture.events.length, emitted);
      if (cancellation === "retry") {
        assert.equal(fixture.binding.state("doc").status, "pending");
        assert.equal(fixture.binding.state("doc").result, null);
        await assert.rejects(
          fixture.host.assets("doc", executor.task.ticket.taskId),
        );
      } else
        await assert.rejects(
          fixture.host.assets("doc", executor.task.ticket.taskId),
        );
    } finally {
      assets.release();
      await fixture.close();
    }
  });
}

test("host timeout wins over success while component IO is pending", async () => {
  const assets = pendingAssets();
  const originalTimeout = globalThis.setTimeout;
  let timeout!: () => void;
  let fixture: Awaited<ReturnType<typeof openHost>>;
  try {
    globalThis.setTimeout = ((
      callback: (...args: unknown[]) => void,
      delay?: number,
      ...args: unknown[]
    ) => {
      if (delay === 30000) {
        timeout = () => callback(...args);
        return originalTimeout(() => {}, 0);
      }
      return originalTimeout(callback, delay, ...args);
    }) as typeof globalThis.setTimeout;
    fixture = await openHost(assets.resources);
  } finally {
    globalThis.setTimeout = originalTimeout;
  }
  try {
    assert.equal(typeof timeout, "function");
    const executor = fixture.executors[0];
    executor.result.resolve(success(executor.task, [component]));
    await assets.entered.promise;
    timeout();
    await fixture.flush();
    assert.equal(executor.signal.aborted, true);
    assert.equal(executor.disposed, true);
    assert.equal(fixture.completions.length, 1);
    assert.equal(fixture.completions[0].outcome.kind, "failure");
    const state = fixture.binding.state("doc");
    assert.equal(state.status, "failed");
    assert.match(state.error!, /超时/);
    assert.equal(state.result, null);
    const emitted = fixture.events.length;
    assets.release();
    await fixture.flush();
    assert.equal(assets.fileReads, 0);
    assert.deepEqual(assets.directories, ["/pkg/components"]);
    assert.equal(fixture.completions.length, 1);
    assert.equal(fixture.events.length, emitted);
    assert.equal(fixture.binding.state("doc").status, "failed");
    await assert.rejects(
      fixture.host.assets("doc", executor.task.ticket.taskId),
    );
  } finally {
    assets.release();
    await fixture.close();
  }
});
