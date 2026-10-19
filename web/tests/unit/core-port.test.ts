import { test } from "node:test";
import assert from "node:assert/strict";
import { wasmCore, coreValue, type CoreReply } from "../../src/lib/editor/core";
import { VaultError } from "../../src/lib/vault/errors";

test("the WASM adapter converts values at its ABI and preserves accepted failure receipts", async () => {
  const calls: { method: string; params: string }[] = [];
  const reply: CoreReply = {
    status: "error",
    error: { code: "IO", message: "file operation failed", path: "中文/a.not" },
    mutations: [{ document: { id: "accepted" } }] as CoreReply["mutations"],
  };
  const core = wasmCore({
    async call(method, params) {
      calls.push({ method, params });
      return JSON.stringify(reply);
    },
  });
  const params = { path: "中文/a.not", peerId: "18446744073709551615" };
  const result = await core.call("save", params);
  assert.deepEqual(calls, [{ method: "save", params: JSON.stringify(params) }]);
  assert.deepEqual(result, reply);
  assert.equal(result.mutations[0].document.id, "accepted");
  assert.throws(() => coreValue(result), /file operation failed/);
});

test("WASM ABI errors preserve structured IO evidence while ordinary failures keep their identity", async () => {
  const io = wasmCore({
    async call() {
      throw JSON.stringify({
        code: "PermissionDenied",
        message: "read-only directory",
        path: "中文/a.not",
        writeNotStarted: true,
      });
    },
  });
  await assert.rejects(io.call("save", {}), (error: unknown) => {
    assert.ok(error instanceof VaultError);
    assert.equal(error.code, "PermissionDenied");
    assert.equal(error.path, "中文/a.not");
    assert.equal(error.writeNotStarted, true);
    return true;
  });

  const original = new Error("binding failed");
  const failed = wasmCore({
    async call() {
      throw original;
    },
  });
  await assert.rejects(
    failed.call("read", {}),
    (error: unknown) => error === original,
  );
});
