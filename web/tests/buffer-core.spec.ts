import { expect, test } from "@playwright/test";
import type {
  BufferCommand,
  BufferUpdate,
  TextEdit,
  TextSnapshot,
} from "../src/lib/editor/contract";
type CoreModule = typeof import("../src/lib/editor/generated/celestite_core");

test("standalone WASM Buffer commands return exact effects without a host or notification queue", async ({
  page,
}) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const wasm = (await import(
      new URL("/src/lib/editor/generated/celestite_core.js", location.href).href
    )) as CoreModule;
    await wasm.default();
    const local = new wasm.BufferBinding(
      JSON.stringify({ document_id: "buffer", history_id: "history" }),
      "1",
      "A😀B",
    );
    let guest: InstanceType<CoreModule["BufferBinding"]> | undefined;
    const snapshot = (buffer: InstanceType<CoreModule["BufferBinding"]>) =>
      JSON.parse(buffer.snapshot()) as TextSnapshot;
    const apply = (
      buffer: InstanceType<CoreModule["BufferBinding"]>,
      command: BufferCommand,
    ) => JSON.parse(buffer.apply(JSON.stringify(command))) as BufferUpdate;
    const edit = (
      buffer: InstanceType<CoreModule["BufferBinding"]>,
      edits: TextEdit[],
    ) =>
      apply(buffer, {
        kind: "edit",
        base: snapshot(buffer).version,
        input: { kind: "edits", edits },
        origin: "keyboard",
        undo: { metadata: { selection: "before-share" }, positions: [] },
      });
    try {
      const localUpdate = edit(local, [{ from: 0, to: 0, insert: "local " }]);
      const initial = snapshot(local);
      guest = wasm.BufferBinding.from_snapshot(local.export_snapshot(), "2");
      const guestUndo = JSON.parse(guest.undo_state());
      const peerUpdate = edit(guest, [
        { from: initial.text.length, to: initial.text.length, insert: " peer" },
      ]);
      const importedUpdate = apply(local, {
        kind: "import",
        packet: peerUpdate.operation!,
        origin: "peer",
      });
      const imported = snapshot(local);
      const undoneUpdate = apply(local, {
        kind: "undo",
        base: imported.version,
        context: { positions: [] },
      });
      const undone = snapshot(local);
      const redoneUpdate = apply(local, {
        kind: "redo",
        base: undone.version,
        context: { positions: [] },
      });
      const redone = snapshot(local);
      let failure: { code: string } | undefined;
      try {
        edit(local, [{ from: 8, to: 8, insert: "invalid" }]);
      } catch (error) {
        failure = JSON.parse(String(error));
      }
      return {
        initial,
        localUpdate,
        peerUpdate,
        guestUndo,
        imported,
        importedUpdate,
        undone,
        undoneUpdate,
        redone,
        redoneUpdate,
        failure,
        afterFailure: snapshot(local),
        writer: local.writer_id(),
        guestWriter: guest.writer_id(),
        hasOldApis:
          "edit" in local ||
          "take_events" in local ||
          "import_updates" in local,
      };
    } finally {
      guest?.free();
      local.free();
    }
  });
  expect(result.initial.text).toBe("local A😀B");
  expect(result.localUpdate.operation).not.toBeNull();
  expect(result.guestUndo.canUndo).toBe(false);
  expect(result.importedUpdate.operation).toEqual(result.peerUpdate.operation);
  expect(result.importedUpdate.cause.kind).toBe("import");
  expect(result.importedUpdate.after).toEqual(result.imported.version);
  expect(result.imported.text).toBe("local A😀B peer");
  expect(result.undone.text).toBe("A😀B peer");
  expect(result.undoneUpdate.restored?.metadata).toEqual({
    selection: "before-share",
  });
  expect(result.redone.text).toBe("local A😀B peer");
  expect(result.redoneUpdate.operation).not.toBeNull();
  expect(result.failure?.code).toBe("invalid_position");
  expect(result.afterFailure).toEqual(result.redone);
  expect(result.writer).toBe("1");
  expect(result.guestWriter).toBe("2");
  expect(result.hasOldApis).toBe(false);
});
