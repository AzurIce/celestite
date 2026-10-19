import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EditorBinding,
  PreviewBinding,
} from "../../src/lib/editor/generated/celestite_core";
import { coreReady, MemoryRecoveryFiles, replaceText } from "./core-runtime";
import { createBrowserIo } from "../../src/lib/editor/local/io";
import { wasmCore } from "../../src/lib/editor/core";
import { LocalEditorSession } from "../../src/lib/editor/local/session";
import { serveEditor } from "../../src/lib/editor/runtime/service";
import { EditorClient, type MessageTransport } from "../../src/lib/editor/rpc";
import { ClientDocuments } from "../../src/lib/editor/client/documents";
import { PreviewResources } from "../../src/lib/preview/resources";
import { vaultPath } from "../../src/lib/vault/path";
import { VaultError } from "../../src/lib/vault/errors";
import type {
  ServiceMessage,
  ServiceRequest,
} from "../../src/lib/editor/contract";

async function withClock(
  run: (clock: {
    settle(): Promise<void>;
    advance(ms: number): Promise<void>;
  }) => Promise<void>,
) {
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  const dateNow = Date.now;
  const epoch = dateNow();
  const timers = new Map<number, { due: number; callback: () => void }>();
  let now = 0;
  let id = 0;
  Date.now = () => epoch + now;
  globalThis.setTimeout = ((callback: () => void, delay = 0) => {
    timers.set(++id, { due: now + delay, callback });
    return id;
  }) as unknown as typeof globalThis.setTimeout;
  globalThis.clearTimeout = ((timer: unknown) => {
    timers.delete(Number(timer));
  }) as typeof globalThis.clearTimeout;
  const settle = async () => {
    for (let turn = 0; turn < 3; turn++)
      await new Promise<void>((resolve) => realSet(resolve, 0));
  };
  try {
    await run({
      settle,
      async advance(ms) {
        const end = now + ms;
        let count = 0;
        while (true) {
          assert.ok(count++ < 100, "background timers must not spin");
          const next = [...timers]
            .filter(([, timer]) => timer.due <= end)
            .sort((a, b) => a[1].due - b[1].due)[0];
          if (!next) break;
          now = next[1].due;
          timers.delete(next[0]);
          next[1].callback();
          await settle();
        }
        now = end;
        await settle();
      },
    });
  } finally {
    globalThis.setTimeout = realSet;
    globalThis.clearTimeout = realClear;
    Date.now = dateNow;
  }
}

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function fixture() {
  await coreReady;
  const files = new MemoryRecoveryFiles();
  files.files.set("a.md", new TextEncoder().encode("disk"));
  const recovery = new MemoryRecoveryFiles();
  const identity = {
    instanceId: "rollback-test",
    vault: { vaultId: "vault", historyId: "history" },
  };
  const binding = await EditorBinding.open(
    JSON.stringify(identity),
    createBrowserIo(files),
    createBrowserIo(recovery),
    false,
  );
  const core = wasmCore(binding);
  const previewBinding = new PreviewBinding();
  const calls: string[] = [];
  let beforeCall = async (_method: string) => {};
  const listeners = new Set<(event: MessageEvent<ServiceMessage>) => void>();
  let incoming!: (event: MessageEvent<ServiceRequest>) => void;
  let detach!: () => void;
  let terminated = false;
  const transport: MessageTransport = {
    postMessage: (data) =>
      queueMicrotask(() => incoming(new MessageEvent("message", { data }))),
    addEventListener: (_, listener) => {
      listeners.add(listener);
    },
    removeEventListener: (_, listener) => {
      listeners.delete(listener);
    },
  };
  const client = new EditorClient(transport);
  const lifetime = serveEditor(
    {
      postMessage: (data) =>
        queueMicrotask(() => {
          for (const listener of listeners)
            listener(new MessageEvent("message", { data }));
        }),
      addEventListener: (_, listener) => {
        incoming = listener;
      },
    },
    async (emit, schedule) => ({
      identity,
      host: new LocalEditorSession(
        {
          async call(method, params) {
            calls.push(method);
            await beforeCall(method);
            return core.call(method, params);
          },
        },
        files,
        emit,
        schedule,
      ),
      previewBinding,
      previewResources: new PreviewResources(files),
      dispose: () => binding.free(),
    }),
    (stop) => {
      detach = stop;
    },
  );
  await client.ready;
  const documents = new ClientDocuments(client, () => {
    terminated = true;
  });
  assert.equal(await documents.open(vaultPath("a.md")), true);
  const document = documents.snapshot().documents[0];
  return {
    files,
    recovery,
    calls,
    documents,
    client,
    document,
    intercept(call: typeof beforeCall) {
      beforeCall = call;
    },
    drafts() {
      return [...recovery.files]
        .filter(([path]) => path.startsWith("recovery/"))
        .map(
          ([, bytes]) =>
            JSON.parse(new TextDecoder().decode(bytes)) as { text: string },
        );
    },
    async cleanup() {
      beforeCall = async () => {};
      if (!terminated) {
        detach();
        documents.detach();
        binding.free();
        previewBinding.free();
      }
      await lifetime;
    },
  };
}

test("failed preview suspension replays an admitted recovery checkpoint through the service", async () => {
  await withClock(async (clock) => {
    const runtime = await fixture();
    const entered = gate();
    const finish = gate();
    try {
      assert.equal(
        replaceText(runtime.documents, runtime.document.id, "first draft"),
        true,
      );
      await clock.settle();
      let pausing = true;
      runtime.intercept(async (method) => {
        if (method === "document_source" && pausing) {
          pausing = false;
          entered.release();
          await finish.promise;
          throw new VaultError("IO", "preview pause failed");
        }
      });
      const suspended = runtime.client.request("suspend", {});
      const rejected = assert.rejects(suspended, /preview pause failed/);
      await entered.promise;
      await clock.advance(500);
      assert.deepEqual(runtime.drafts(), []);
      finish.release();
      await rejected;
      await clock.settle();
      assert.deepEqual(
        runtime.drafts().map((draft) => draft.text),
        ["first draft"],
      );
      assert.equal(
        runtime.calls.filter((method) => method === "checkpoint").length,
        1,
      );
      assert.equal(
        replaceText(runtime.documents, runtime.document.id, "second draft"),
        true,
      );
      await clock.settle();
      await clock.advance(500);
      assert.deepEqual(
        runtime.drafts().map((draft) => draft.text),
        ["second draft"],
      );
      assert.equal(
        runtime.calls.filter((method) => method === "checkpoint").length,
        2,
      );
    } finally {
      finish.release();
      await runtime.cleanup();
    }
  });
});

for (const keepDeadline of ["composition", "read failure"] as const) {
  test(`failed browser close publishes recovery errors and resumes checkpoints after ${keepDeadline}`, async () => {
    await withClock(async (clock) => {
      const runtime = await fixture();
      const entered = gate();
      const finish = gate();
      const write = runtime.recovery.writeFile.bind(runtime.recovery);
      const read = runtime.files.readFile.bind(runtime.files);
      let failed = false;
      runtime.recovery.writeFile = async (...args) => {
        if (!failed && args[0].startsWith("recovery/")) {
          failed = true;
          entered.release();
          await finish.promise;
          throw new VaultError("IO", "close checkpoint failed", args[0]);
        }
        return write(...args);
      };
      try {
        if (keepDeadline === "composition") {
          runtime.documents.composition(runtime.document.id, true);
          await clock.settle();
        }
        assert.equal(
          replaceText(runtime.documents, runtime.document.id, "first draft"),
          true,
        );
        await clock.settle();
        if (keepDeadline === "read failure") {
          runtime.files.readFile = async () => {
            throw new VaultError("IO", "save read failed");
          };
        }
        const closed = runtime.documents.close();
        const rejected = assert.rejects(closed, /close checkpoint failed/);
        await entered.promise;
        await clock.advance(500);
        finish.release();
        await rejected;
        await clock.settle();
        assert.match(
          runtime.documents.snapshot().documents[0].core?.recoveryError ?? "",
          /close checkpoint failed/,
        );
        assert.equal(
          replaceText(runtime.documents, runtime.document.id, "second draft"),
          true,
        );
        await clock.settle();
        await clock.advance(500);
        assert.deepEqual(
          runtime.drafts().map((draft) => draft.text),
          ["second draft"],
        );
        assert.equal(
          runtime.documents.snapshot().documents[0].core?.recoveryError,
          null,
        );
        assert.equal(
          runtime.calls.filter((method) => method === "checkpoint").length,
          1,
        );
      } finally {
        finish.release();
        runtime.files.readFile = read;
        runtime.recovery.writeFile = write;
        await runtime.cleanup();
      }
    });
  });
}

test("a failed close keeps its checkpoint error when metadata refresh also fails", async () => {
  const runtime = await fixture();
  try {
    runtime.documents.composition(runtime.document.id, true);
    assert.equal(
      replaceText(runtime.documents, runtime.document.id, "retained draft"),
      true,
    );
    runtime.recovery.failWrites = true;
    runtime.intercept(async (method) => {
      if (method === "resident")
        throw new VaultError("IO", "metadata refresh failed");
    });
    await assert.rejects(runtime.documents.close(), /recovery write failed/);
  } finally {
    await runtime.cleanup();
  }
});

test("successful browser close discards recovery work that became due during the final checkpoint", async () => {
  await withClock(async (clock) => {
    const runtime = await fixture();
    const entered = gate();
    const finish = gate();
    const write = runtime.recovery.writeFile.bind(runtime.recovery);
    let writes = 0;
    runtime.recovery.writeFile = async (...args) => {
      if (args[0].startsWith("recovery/")) {
        writes++;
        entered.release();
        await finish.promise;
      }
      return write(...args);
    };
    try {
      runtime.documents.composition(runtime.document.id, true);
      await clock.settle();
      assert.equal(
        replaceText(runtime.documents, runtime.document.id, "final draft"),
        true,
      );
      await clock.settle();
      const closed = runtime.documents.close();
      await entered.promise;
      await clock.advance(500);
      finish.release();
      await closed;
      await clock.advance(10_000);
      assert.equal(writes, 1);
      assert.equal(
        runtime.calls.filter((method) => method === "checkpoint").length,
        0,
      );
      assert.deepEqual(
        runtime.drafts().map((draft) => draft.text),
        ["final draft"],
      );
    } finally {
      finish.release();
      await runtime.cleanup();
    }
  });
});
