import { test } from "node:test";
import assert from "node:assert/strict";
import { startEditorWorker } from "../../src/lib/editor/client/worker";
import { VaultError } from "../../src/lib/vault/errors";

for (const phase of ["post", "ready"] as const) {
  test(`Worker ${phase} failure releases the lifetime and preserves the startup error`, async () => {
    const failure = new VaultError("IO", "startup failed");
    const listeners = new Map<string, Set<(event: unknown) => void>>();
    let terminated = false;
    let closed = false;
    const worker = {
      addEventListener(type: string, listener: (event: unknown) => void) {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type)!.add(listener);
      },
      removeEventListener(type: string, listener: (event: unknown) => void) {
        listeners.get(type)?.delete(listener);
      },
      postMessage() {
        if (phase === "post") throw failure;
        queueMicrotask(() => {
          for (const listener of listeners.get("message") ?? [])
            listener({
              data: {
                kind: "fatal",
                error: { code: failure.code, message: failure.message },
              },
            });
        });
      },
      terminate() {
        terminated = true;
      },
    } as unknown as Worker;
    const backend = {
      async close() {
        closed = true;
        throw new Error("cleanup failed");
      },
    };
    await assert.rejects(
      startEditorWorker(
        worker,
        { kind: "initialize", url: "http://localhost" },
        backend,
      ),
      (error: unknown) =>
        error instanceof VaultError &&
        error.message === failure.message &&
        (phase !== "post" || error === failure),
    );
    assert.equal(terminated, true);
    assert.equal(closed, true);
    assert.equal(
      [...listeners.values()].every((set) => set.size === 0),
      true,
    );
  });
}
