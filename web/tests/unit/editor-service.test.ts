import { test } from "node:test";
import assert from "node:assert/strict";
import {
  serveEditor,
  type EditorServiceHost,
} from "../../src/lib/editor/runtime/service";
import type {
  ServiceDocument,
  ServiceMessage,
  ServiceRequest,
} from "../../src/lib/editor/contract";
import { VaultError } from "../../src/lib/vault/errors";
import { readFile } from "node:fs/promises";
import init, {
  DocumentSourceSnapshot,
  PreviewBinding,
} from "../../src/lib/editor/generated/celestite_core";
import { PreviewResources } from "../../src/lib/preview/resources";
import type { VaultBackend } from "../../src/lib/vault/types";
import { LocalEditorSession } from "../../src/lib/editor/local/session";
import type { CoreDocument, CorePort } from "../../src/lib/editor/core";

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

for (const operation of ["open", "checkpoint", "resolve"] as const) {
  for (const rejected of [false, true]) {
    test(`detached ${operation} yields the service queue and keeps its own outcome when preview refresh fails (rejected=${rejected})`, async () => {
      await init({
        module_or_path: await readFile(
          new URL(
            "../../src/lib/editor/generated/celestite_core_bg.wasm",
            import.meta.url,
          ),
        ),
      });
      const messages: ServiceMessage[] = [];
      let incoming!: (event: MessageEvent<ServiceRequest>) => void;
      let finish!: () => void;
      let schedule!: (task: () => Promise<unknown>) => void;
      let acknowledged = false;
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
        async [operation]() {
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
      } as unknown as EditorServiceHost;
      const lifetime = serveEditor(
        {
          postMessage: (message) => messages.push(message),
          addEventListener: (_, listener) => {
            incoming = listener;
          },
        },
        async (_emit, scheduleTask) => {
          schedule = scheduleTask;
          return {
            host,
            previewBinding: new PreviewBinding(),
            previewResources: new PreviewResources({} as VaultBackend),
            identity: {
              instanceId: "i",
              vault: { vaultId: "v", historyId: "h" },
            },
            dispose: () => {},
          };
        },
      );
      await settle();
      const ready = messages[0];
      assert.equal(ready.kind, "ready");
      if (ready.kind !== "ready") throw new Error("service not ready");
      const request = (
        requestId: number,
        method: ServiceRequest["method"],
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
        } as MessageEvent<ServiceRequest>);
      try {
        request(
          1,
          operation,
          operation === "open"
            ? { path: "a.md" }
            : operation === "resolve"
              ? { id: "doc", action: "retry" }
              : { id: "doc" },
        );
        await settle();
        assert.equal(started, true);
        assert.equal(refreshes, 0);
        request(2, "read", { id: "doc" });
        await settle();
        assert.ok(
          messages.some((m) => m.kind === "reply" && m.requestId === 2),
        );
        assert.equal(refreshes, 1);
        failPreview = true;
        if (operation !== "open") {
          // Remote checkpoint and retry can wait for confirmation admitted through the
          // service scheduler. That work must run while the command is waiting.
          schedule(async () => {
            acknowledged = true;
            finish();
          });
        } else finish();
        await settle();
        const replyIndex = messages.findIndex(
          (m) => m.kind === "reply" && m.requestId === 1,
        );
        const reply = messages[replyIndex];
        assert.equal(reply?.kind, "reply");
        if (reply.kind !== "reply") throw new Error("missing open reply");
        if (rejected) assert.equal(reply.error?.message, "open failed");
        else assert.deepEqual(reply.result, document);
        assert.equal(refreshes, operation === "open" ? 2 : 3);
        if (operation !== "open") assert.equal(acknowledged, true);
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
}

for (const operation of ["checkpoint", "save"] as const) {
  test(`automatic ${operation} failures publish document errors without a fatal service event`, async () => {
    await init({
      module_or_path: await readFile(
        new URL(
          "../../src/lib/editor/generated/celestite_core_bg.wasm",
          import.meta.url,
        ),
      ),
    });
    let state: CoreDocument = {
      id: "doc",
      path: "a.md",
      snapshot: { text: "draft", stateRevision: 1 },
      version: {
        identity: { document_id: "doc", history_id: "history" },
        clocks: { "1": 1 },
      },
      undo: { canUndo: true, canRedo: false },
      peerId: "1",
      savedContent: "disk",
      savedVersion: null,
      dirty: true,
      bom: false,
      lineEnding: "\n",
      deleted: false,
      conflict: false,
      recoveryError: null,
      recoveryDelay: operation === "checkpoint" ? 0 : null,
      error: null,
      autosaveDelay: operation === "save" ? 0 : null,
      fileRevision: "disk",
    };
    let attempts = 0;
    const core: CorePort = {
      async call(method) {
        if (method === operation) {
          attempts++;
          state = {
            ...state,
            ...(operation === "checkpoint"
              ? { recoveryError: "checkpoint failed", recoveryDelay: null }
              : { error: "unsupported save", autosaveDelay: null }),
          };
          return {
            status: "error",
            mutations: [],
            error:
              operation === "checkpoint"
                ? { code: "IO", message: "checkpoint failed" }
                : { code: "Unsupported", message: "unsupported save" },
          };
        }
        const value =
          method === "resident"
            ? [state]
            : method === "document_source"
              ? { epoch: 1, documents: [], snapshots: [] }
              : method === "close"
                ? null
                : state;
        return { status: "ok", mutations: [], value };
      },
    };
    const messages: ServiceMessage[] = [];
    let incoming!: (event: MessageEvent<ServiceRequest>) => void;
    const lifetime = serveEditor(
      {
        postMessage: (message) => messages.push(message),
        addEventListener: (_, listener) => {
          incoming = listener;
        },
      },
      async (emit, schedule) => ({
        identity: {
          instanceId: "instance",
          vault: { vaultId: "vault", historyId: "history" },
        },
        host: new LocalEditorSession(
          core,
          { close: async () => {} } as VaultBackend,
          emit,
          schedule,
        ),
        previewBinding: new PreviewBinding(),
        previewResources: new PreviewResources({} as VaultBackend),
        dispose: () => {},
      }),
    );
    await settle();
    const ready = messages.find((message) => message.kind === "ready")!;
    assert.equal(ready.kind, "ready");
    if (ready.kind !== "ready") throw new Error("service not ready");
    const request = (requestId: number, method: string, params = {}) =>
      incoming({
        data: {
          kind: "request",
          requestId,
          method,
          params,
          sessionId: ready.sessionId,
        },
      } as MessageEvent<ServiceRequest>);
    try {
      request(1, "open", { path: "a.md" });
      for (let turn = 0; turn < 10 && attempts === 0; turn++) await settle();
      await settle();
      assert.equal(attempts, 1);
      assert.ok(
        messages.some(
          (message) =>
            message.kind === "document" &&
            (operation === "checkpoint"
              ? message.document.core?.recoveryError === "checkpoint failed"
              : message.document.error === "unsupported save"),
        ),
      );
      assert.equal(
        messages.some((message) => message.kind === "fatal"),
        false,
      );
      request(2, "read", { id: "doc" });
      await settle();
      const reply = messages.find(
        (message) => message.kind === "reply" && message.requestId === 2,
      );
      assert.equal(reply?.kind, "reply");
      if (reply?.kind !== "reply") throw new Error("read reply missing");
      assert.equal(reply.error, undefined);
      assert.equal((reply.result as ServiceDocument).content, "draft");
      assert.equal(attempts, 1);
    } finally {
      request(3, "close");
      await lifetime;
    }
  });
}
