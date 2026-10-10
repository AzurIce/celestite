import { test } from "node:test";
import assert from "node:assert/strict";
import {
  serveEditor,
  type EditorWorkerHost,
} from "../../src/lib/editor/runtime/service";
import type {
  ServiceDocument,
  WorkerMessage,
  WorkerRequest,
} from "../../src/lib/editor/contract";
import { VaultError } from "../../src/lib/vault/errors";
import { readFile } from "node:fs/promises";
import init, {
  DocumentSourceSnapshot,
  PreviewBinding,
} from "../../src/lib/editor/generated/celestite_core";
import { PreviewResources } from "../../src/lib/preview/resources";
import type { VaultBackend } from "../../src/lib/vault/types";

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

for (const rejected of [false, true]) {
  test(`detached IO yields the service queue and keeps its own outcome when preview refresh fails (rejected=${rejected})`, async () => {
    await init({
      module_or_path: await readFile(
        new URL(
          "../../src/lib/editor/generated/celestite_core_bg.wasm",
          import.meta.url,
        ),
      ),
    });
    const messages: WorkerMessage[] = [];
    let incoming!: (event: MessageEvent<WorkerRequest>) => void;
    let finish!: () => void;
    let started = false;
    let refreshes = 0;
    let failPreview = false;
    const document = { id: "doc" } as ServiceDocument;
    const pending = new Promise<ServiceDocument>((resolve, reject) => {
      finish = () =>
        rejected
          ? reject(new VaultError("IO", "open failed"))
          : resolve(document);
    });
    const host = {
      async open() {
        started = true;
        return pending;
      },
      async read() {
        return document;
      },
      async withSource<T>(
        _ids: readonly string[],
        consume: (source: DocumentSourceSnapshot) => T,
      ) {
        refreshes++;
        if (failPreview) throw new Error("preview failed");
        return consume({ epoch: 1, documents: [], snapshots: [] });
      },
      async close() {},
    } as unknown as EditorWorkerHost;
    const lifetime = serveEditor(
      {
        postMessage: (message) => messages.push(message),
        addEventListener: (_, listener) => {
          incoming = listener;
        },
      },
      async () => ({
        host,
        previewBinding: new PreviewBinding(),
        previewResources: new PreviewResources({} as VaultBackend),
        identity: { instanceId: "i", vault: { vaultId: "v", historyId: "h" } },
        dispose: () => {},
      }),
    );
    await settle();
    const ready = messages[0];
    assert.equal(ready.kind, "ready");
    if (ready.kind !== "ready") throw new Error("service not ready");
    const request = (
      requestId: number,
      method: WorkerRequest["method"],
      params: Record<string, unknown> = {},
    ) =>
      incoming({
        data: {
          kind: "request",
          requestId,
          sessionId: ready.sessionId,
          method,
          params,
        },
      } as MessageEvent<WorkerRequest>);
    try {
      request(1, "open", { path: "a.md" });
      await settle();
      assert.equal(started, true);
      assert.equal(refreshes, 0);
      request(2, "read", { id: "doc" });
      await settle();
      assert.ok(messages.some((m) => m.kind === "reply" && m.requestId === 2));
      assert.equal(refreshes, 1);
      failPreview = true;
      finish();
      await settle();
      const replyIndex = messages.findIndex(
        (m) => m.kind === "reply" && m.requestId === 1,
      );
      const reply = messages[replyIndex];
      assert.equal(reply?.kind, "reply");
      if (reply.kind !== "reply") throw new Error("missing open reply");
      if (rejected) assert.equal(reply.error?.message, "open failed");
      else assert.deepEqual(reply.result, document);
      assert.equal(refreshes, 2);
      assert.equal(
        messages.some((m) => m.kind === "fatal"),
        false,
      );
    } finally {
      finish();
      request(3, "close");
      await lifetime;
    }
  });
}
