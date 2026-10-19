import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BufferBinding,
  EditorBinding,
} from "../../src/lib/editor/generated/celestite_core";
import {
  coreValue,
  wasmCore,
  type CoreDocument,
} from "../../src/lib/editor/core";
import { createBrowserIo } from "../../src/lib/editor/local/io";
import { vaultPath } from "../../src/lib/vault/path";
import { coreReady, MemoryRecoveryFiles } from "./core-runtime";

const bytes = (text: string) => new TextEncoder().encode(text);
const identity = () => ({
  instanceId: "stable-instance",
  vault: { vaultId: "stable-vault", historyId: crypto.randomUUID() },
});

async function open(
  files: MemoryRecoveryFiles,
  recovery: MemoryRecoveryFiles,
  merge = false,
) {
  await coreReady;
  const binding = await EditorBinding.open(
    JSON.stringify(identity()),
    createBrowserIo(files),
    createBrowserIo(recovery),
    merge,
  );
  const core = wasmCore(binding);
  return {
    binding,
    call: async <T>(method: string, params: Record<string, unknown> = {}) =>
      coreValue<T>(await core.call(method, params)),
    reply: core.call,
  };
}
async function edit(
  core: Awaited<ReturnType<typeof open>>,
  document: CoreDocument,
  text: string,
) {
  const reply = await core.reply("apply", {
    id: document.id,
    command: {
      kind: "edit",
      base: document.version,
      input: { kind: "text", text },
    },
  });
  coreValue(reply);
  const mutation = reply.mutations
    .filter((entry) => entry.document.id === document.id)
    .at(-1)!;
  assert.ok(mutation);
  assert.equal("history" in mutation, false);
  return mutation.document;
}

test("browser recovery stores plaintext and disk baseline, then restores a fresh CRDT session", async () => {
  const files = new MemoryRecoveryFiles();
  const recovery = new MemoryRecoveryFiles();
  files.files.set("note.md", bytes("disk baseline"));
  const first = await open(files, recovery);
  const id = (await first.call<CoreDocument>("open", { path: "note.md" })).id;
  const before = await first.call<CoreDocument>("read", { id });
  await edit(first, before, "unsaved 😀 draft");
  assert.equal(
    [...recovery.files.keys()].some((path) => path.startsWith("recovery/")),
    false,
  );
  await first.call("checkpoint");
  const records = [...recovery.files.entries()].filter(([path]) =>
    path.startsWith("recovery/"),
  );
  assert.equal(records.length, 1);
  const stored = JSON.parse(new TextDecoder().decode(records[0][1]));
  assert.equal(stored.text, "unsaved 😀 draft");
  assert.deepEqual(stored.baseline.bytes, Array.from(bytes("disk baseline")));
  for (const field of ["id", "version", "seed", "journal", "history"])
    assert.equal(field in stored, false);
  first.binding.free(); // Abrupt owner loss: no save/close call.
  const second = await open(files, recovery);
  try {
    const restoredId = (
      await second.call<CoreDocument>("open", { path: "note.md" })
    ).id;
    const restored = await second.call<CoreDocument>("read", {
      id: restoredId,
    });
    assert.equal(restored.snapshot.text, "unsaved 😀 draft");
    assert.equal(restored.savedContent, "disk baseline");
    assert.notEqual(restored.id, before.id);
    assert.notDeepEqual(restored.version.identity, before.version.identity);
    assert.equal(restored.undo.canUndo, false);
    assert.equal(
      new TextDecoder().decode(await files.readFile(vaultPath("note.md"))),
      "disk baseline",
    );
  } finally {
    second.binding.free();
  }
});

test("failed recovery checkpoints preserve accepted edits and close can retry", async () => {
  const files = new MemoryRecoveryFiles();
  const recovery = new MemoryRecoveryFiles();
  files.files.set("note.md", bytes("disk"));
  const core = await open(files, recovery);
  try {
    const id = (await core.call<CoreDocument>("open", { path: "note.md" })).id;
    let document = await core.call<CoreDocument>("read", { id });
    recovery.failWrites = true;
    document = await edit(core, document, "first draft");
    assert.equal(document.recoveryError, null);
    assert.equal((await core.reply("checkpoint", {})).status, "error");
    document = await core.call<CoreDocument>("read", { id });
    assert.match(document.recoveryError!, /recovery write failed/);
    assert.equal(document.recoveryDelay, null);
    document = await edit(core, document, "second draft");
    assert.equal(document.snapshot.text, "second draft");
    assert.equal((await core.reply("close", {})).status, "error");
    document = await edit(core, document, "still editable after close failure");
    recovery.failWrites = false;
    await core.call("checkpoint");
    assert.equal(
      (await core.call<CoreDocument>("read", { id })).recoveryError,
      null,
    );
    await core.call("close");
    const stored = [...recovery.files.entries()].find(([path]) =>
      path.startsWith("recovery/"),
    )!;
    assert.equal(
      JSON.parse(new TextDecoder().decode(stored[1])).text,
      "still editable after close failure",
    );
    assert.equal(
      new TextDecoder().decode(await files.readFile(vaultPath("note.md"))),
      "disk",
    );
  } finally {
    core.binding.free();
  }
});

test("clean documents and successful saves leave no plaintext draft records", async () => {
  const files = new MemoryRecoveryFiles();
  const recovery = new MemoryRecoveryFiles();
  files.files.set("note.md", bytes("disk baseline"));
  const core = await open(files, recovery);
  try {
    const document = await core.call<CoreDocument>("open", { path: "note.md" });
    const drafts = () =>
      [...recovery.files.keys()].filter((path) => path.startsWith("recovery/"));
    assert.deepEqual(drafts(), []);
    await edit(core, document, "saved plaintext");
    await core.call("checkpoint");
    assert.equal(drafts().length, 1);
    const saved = await core.call<CoreDocument>("save", { id: document.id });
    assert.equal(saved.error, null);
    assert.equal(saved.dirty, false);
    assert.deepEqual(drafts(), []);
    assert.equal(
      new TextDecoder().decode(await files.readFile(vaultPath("note.md"))),
      "saved plaintext",
    );
    assert.equal(
      [...recovery.files.keys()].some((path) => path.startsWith("documents/")),
      false,
    );
  } finally {
    core.binding.free();
  }
});

test("restored drafts reconcile external disk changes from their plaintext baseline", async () => {
  const files = new MemoryRecoveryFiles();
  const recovery = new MemoryRecoveryFiles();
  files.files.set("note.md", bytes("first\nsecond\n"));
  const first = await open(files, recovery, true);
  const id = (await first.call<CoreDocument>("open", { path: "note.md" })).id;
  await edit(
    first,
    await first.call<CoreDocument>("read", { id }),
    "LOCAL\nsecond\n",
  );
  await first.call("checkpoint");
  first.binding.free();
  files.files.set("note.md", bytes("first\nREMOTE\n"));
  const second = await open(files, recovery, true);
  try {
    const restoredId = (
      await second.call<CoreDocument>("open", { path: "note.md" })
    ).id;
    const restored = await second.call<CoreDocument>("read", {
      id: restoredId,
    });
    assert.equal(restored.snapshot.text, "LOCAL\nREMOTE\n");
    assert.equal(restored.savedContent, "first\nREMOTE\n");
    assert.equal(restored.conflict, false);
  } finally {
    second.binding.free();
  }
});

test("legacy browser journals are rescued once as text and never become the new CRDT identity", async () => {
  await coreReady;
  const files = new MemoryRecoveryFiles();
  const recovery = new MemoryRecoveryFiles();
  files.files.set("note.md", bytes("disk baseline"));
  const legacyIdentity = {
    document_id: "00000000-0000-4000-8000-000000000001",
    history_id: "00000000-0000-4000-8000-000000000002",
  };
  const buffer = new BufferBinding(
    JSON.stringify(legacyIdentity),
    "1234",
    "legacy unsaved text",
  );
  const packet = JSON.parse(buffer.export_snapshot());
  const version = JSON.parse(buffer.snapshot()).version;
  buffer.free();
  const json = (value: unknown) => bytes(JSON.stringify(value));
  recovery.files.set(
    "catalog.json",
    json({
      schema: 1,
      entries: [
        {
          id: legacyIdentity.document_id,
          historyId: legacyIdentity.history_id,
          path: "note.md",
          deleted: false,
        },
      ],
    }),
  );
  recovery.files.set(
    "documents/00000000-0000-4000-8000-000000000001/seed.bin",
    new Uint8Array(packet.data),
  );
  recovery.files.set(
    "documents/00000000-0000-4000-8000-000000000001/head.json",
    json({ sequence: 0, version }),
  );
  recovery.files.set(
    "documents/00000000-0000-4000-8000-000000000001/projection.json",
    json({
      savedContent: "disk baseline",
      diskRevision: Array.from(bytes("disk baseline")).join(","),
      bom: false,
      lineEnding: "\n",
    }),
  );
  const first = await open(files, recovery);
  const id = (await first.call<CoreDocument>("open", { path: "note.md" })).id;
  const restored = await first.call<CoreDocument>("read", { id });
  assert.equal(restored.snapshot.text, "legacy unsaved text");
  assert.notDeepEqual(restored.version.identity, legacyIdentity);
  first.binding.free();
  recovery.files.set("catalog.json", bytes("invalid retired catalog"));
  const second = await open(files, recovery);
  try {
    const next = (await second.call<CoreDocument>("open", { path: "note.md" }))
      .id;
    assert.equal(
      (await second.call<CoreDocument>("read", { id: next })).snapshot.text,
      "legacy unsaved text",
    );
  } finally {
    second.binding.free();
  }
});

test("close flushes the latest coalesced draft before its recovery timer is due", async () => {
  const files = new MemoryRecoveryFiles();
  const recovery = new MemoryRecoveryFiles();
  files.files.set("note.md", bytes("disk baseline"));
  const core = await open(files, recovery);
  try {
    let document = await core.call<CoreDocument>("open", { path: "note.md" });
    for (const text of ["a", "ab", "abc"])
      document = await edit(core, document, text);
    assert.ok(document.recoveryDelay !== null);
    assert.equal(
      [...recovery.files.keys()].some((path) => path.startsWith("recovery/")),
      false,
    );
    await core.call("close");
    const stored = [...recovery.files.entries()].find(([path]) =>
      path.startsWith("recovery/"),
    )!;
    assert.equal(JSON.parse(new TextDecoder().decode(stored[1])).text, "abc");
    assert.equal(
      (await core.call<CoreDocument>("read", { id: document.id }))
        .recoveryDelay,
      null,
    );
    assert.equal(
      new TextDecoder().decode(await files.readFile(vaultPath("note.md"))),
      "disk baseline",
    );
  } finally {
    core.binding.free();
  }
});
