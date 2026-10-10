import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import init, {
  MemoryEditorBinding,
  BufferBinding,
  PreviewBinding,
} from "../../src/lib/editor/generated/celestite_core";
import { PreviewHost } from "../../src/lib/preview/host";
import type { PreviewResources } from "../../src/lib/preview/resources";
import type { PreviewTask } from "../../src/lib/preview/contract";
import { EditorHost } from "../../src/lib/editor/runtime/host";
import type { VaultBackend } from "../../src/lib/vault/types";

class Executor extends EventTarget {
  tasks: PreviewTask[] = [];
  terminated = false;
  postMessage(task: PreviewTask) {
    this.tasks.push(task);
  }
  terminate() {
    this.terminated = true;
  }
}

class SourceEditor extends EditorHost {
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
  const core = await MemoryEditorBinding.open(
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
  const editor = new SourceEditor(
    core,
    {} as VaultBackend,
    () => {},
    () => {},
  );
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
      return executor as unknown as Worker;
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
    executors[1].dispatchEvent(
      new MessageEvent("message", {
        data: {
          taskId: oldEpoch.ticket.taskId,
          outcome: {
            kind: "success",
            output: { html: "late old epoch", diagnostics: [] },
          },
        },
      }),
    );
    assert.equal(binding.state("doc").result, null);
  } finally {
    host.close();
    seed.free();
    core.free();
  }
});
