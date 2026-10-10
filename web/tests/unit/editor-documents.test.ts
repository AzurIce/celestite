import { test } from "node:test";
import assert from "node:assert/strict";
import type { EditorDocuments } from "../../src/lib/editor/contract";
import { createTestEditor, replaceText } from "./core-runtime";
const MAX_EDITABLE_BYTES = 5 * 1024 * 1024;
import { ROOT_PATH, vaultPath, VaultError } from "../../src/lib/vault";
import type {
  VaultBackend,
  VaultPath,
  WriteFileOptions,
} from "../../src/lib/vault";
import {
  FileTreeModel,
  isWithin,
  parentPath,
} from "../../src/lib/file-tree/model";

const path = vaultPath;
const bytes = (text: string) => new TextEncoder().encode(text);
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
class Files implements VaultBackend {
  files = new Map<VaultPath, Uint8Array>();
  directories = new Set<VaultPath>([ROOT_PATH, path("folder")]);
  log: string[] = [];
  onWrite?: (key: VaultPath, content: Uint8Array) => Promise<void> | void;
  onRead?: (key: VaultPath) => Promise<void> | void;
  onRename?: () => Promise<void> | void;
  closed = false;
  constructor() {
    this.file("a.md", "alpha");
    this.file("b.ts", "const b = 1;");
  }
  file(key: string, text: string | Uint8Array) {
    this.files.set(path(key), typeof text === "string" ? bytes(text) : text);
  }
  text(key: string) {
    return new TextDecoder().decode(this.files.get(path(key)));
  }
  async *readDir(parent: VaultPath) {
    for (const key of this.directories)
      if (key !== ROOT_PATH && parentPath(key) === parent)
        yield { path: key, kind: "directory" as const };
    for (const key of this.files.keys())
      if (parentPath(key) === parent)
        yield { path: key, kind: "file" as const };
  }
  async stat(key: VaultPath) {
    if (this.directories.has(key))
      return { path: key, kind: "directory" as const };
    const content = this.files.get(key);
    return content
      ? { path: key, kind: "file" as const, size: content.length }
      : null;
  }
  async readFile(key: VaultPath) {
    await this.onRead?.(key);
    const content = this.files.get(key);
    if (!content) throw new VaultError("NotFound", "missing", key);
    return content.slice();
  }
  async readFileSnapshot(key: VaultPath) {
    const data = await this.readFile(key);
    return { data, revision: Array.from(data).join(",") };
  }
  async writeFile(
    key: VaultPath,
    content: Uint8Array,
    options: WriteFileOptions,
  ) {
    this.log.push(`write:${key}:${new TextDecoder().decode(content)}`);
    try {
      await this.onWrite?.(key, content);
    } catch (error) {
      if (error instanceof VaultError)
        throw new VaultError(error.code, error.message, key, error, true);
      throw error;
    }
    if (options.mode === "replace" && !this.files.has(key))
      throw new VaultError("NotFound", "missing", key);
    if (options.mode === "create" && this.files.has(key))
      throw new VaultError("AlreadyExists", "exists", key);
    if (
      options.expectedRevision !== undefined &&
      options.expectedRevision !== (await this.readFileSnapshot(key)).revision
    )
      throw new VaultError("Conflict", "changed", key);
    this.files.set(key, content.slice());
    return Array.from(content).join(",");
  }
  async mkdir(key: VaultPath) {
    this.directories.add(key);
  }
  async rename(from: VaultPath, to: VaultPath) {
    this.log.push(`rename:${from}:${to}`);
    await this.onRename?.();
    if (!(await this.stat(from)))
      throw new VaultError("NotFound", "missing", from);
    if (await this.stat(to))
      throw new VaultError("AlreadyExists", "exists", to);
    for (const [key, content] of [...this.files])
      if (isWithin(key, from)) {
        this.files.delete(key);
        this.files.set(path(to + key.slice(from.length)), content);
      }
    for (const key of [...this.directories])
      if (isWithin(key, from)) {
        this.directories.delete(key);
        this.directories.add(path(to + key.slice(from.length)));
      }
  }
  async remove(key: VaultPath) {
    this.log.push(`remove:${key}`);
    for (const file of this.files.keys())
      if (isWithin(file, key)) this.files.delete(file);
    for (const directory of this.directories)
      if (isWithin(directory, key)) this.directories.delete(directory);
  }
  async watch() {
    return () => {};
  }
  async close() {
    this.closed = true;
    this.log.push("close");
  }
}
const active = (documents: EditorDocuments) =>
  documents
    .snapshot()
    .documents.find((record) => record.id === documents.snapshot().activeId)!;
const create = async () => {
  const files = new Files();
  return { files, documents: (await createTestEditor(files)).documents };
};

async function versioned() {
  const files = new Files();
  const backend: VaultBackend = files;
  let version = 0;
  const written: string[] = [];
  const originalWrite = files.writeFile.bind(files);
  backend.readFileSnapshot = async (path) => ({
    data: await files.readFile(path),
    revision: String(version),
  });
  backend.writeFile = async (path, data, options) => {
    written.push(options.expectedRevision!);
    if (options.expectedRevision !== String(version))
      throw new VaultError("Conflict", "changed", path);
    await originalWrite(path, data, options);
    return String(++version);
  };
  return {
    files,
    backend,
    written,
    documents: (await createTestEditor(backend)).documents,
    external(text: string | Uint8Array) {
      files.file("a.md", text);
      version++;
    },
  };
}

async function conflictedDraft() {
  const fixture = await versioned();
  await fixture.documents.open(path("a.md"));
  const id = active(fixture.documents).id;
  fixture.external("external");
  replaceText(fixture.documents, id, "draft");
  return { ...fixture, id };
}

test("background conflicts do not prompt, and cancel preserves disk and draft", async () => {
  const { files, documents, id } = await conflictedDraft();
  assert.equal(await documents.save(), false);
  assert.equal(active(documents).conflict, true);
  assert.equal(documents.snapshot().conflictPrompt, null);
  assert.equal(await documents.requestSave(), false);
  assert.deepEqual(documents.snapshot().conflictPrompt, { id, intent: "save" });
  await documents.resolveConflict("cancel");
  assert.equal(active(documents).content, "draft");
  assert.equal(active(documents).dirty, true);
  assert.equal(files.text("a.md"), "external");
  assert.equal(documents.snapshot().conflictPrompt, null);
  await documents.requestCloseDocument(id);
  assert.equal(documents.snapshot().conflictPrompt?.intent, "close");
  await documents.resolveConflict("cancel");
  assert.equal(documents.has(id), true);
  await documents.close();
});

test("overwrite uses the newest disk baseline and subsequent saves use the committed revision", async () => {
  const { files, documents, written } = await conflictedDraft();
  await documents.requestSave();
  assert.equal(await documents.resolveConflict("overwrite"), true);
  // The core rejects stale disk state before issuing a write.
  assert.deepEqual(written, ["1"]);
  assert.equal(files.text("a.md"), "draft");
  assert.equal(active(documents).dirty, false);
  assert.equal(active(documents).conflict, false);
  replaceText(documents, active(documents).id, "next edit");
  assert.equal(await documents.requestSave(), true);
  assert.deepEqual(written, ["1", "2"]);
  await documents.close();
});

test("discard reloads latest text, encoding and view generation without rewriting disk", async () => {
  const { files, documents, external, written } = await conflictedDraft();
  await documents.requestSave();
  external("\ufefflatest\r\nversion\r\n");
  assert.equal(await documents.resolveConflict("discard"), true);
  assert.equal(active(documents).content, "latest\nversion\n");
  assert.equal(active(documents).lineEnding, "\r\n");
  assert.equal(active(documents).bom, true);
  assert.equal(active(documents).reloadVersion, 1);
  assert.equal(active(documents).dirty, false);
  assert.deepEqual(written, []);
  assert.deepEqual(
    files.files.get(path("a.md")),
    bytes("\ufefflatest\r\nversion\r\n"),
  );
  replaceText(documents, active(documents).id, "after reload\n");
  assert.equal(await documents.save(), true);
  assert.equal(written[0], "2");
  await documents.close();
});

for (const action of ["overwrite", "discard"] as const) {
  test(`${action} finishes the original close request`, async () => {
    const { files, documents, id } = await conflictedDraft();
    assert.equal(await documents.requestCloseDocument(id), false);
    assert.equal(await documents.resolveConflict(action), true);
    assert.equal(documents.has(id), false);
    assert.equal(
      files.text("a.md"),
      action === "overwrite" ? "draft" : "external",
    );
    await documents.close();
  });
}

test("another edit between conflict reread and commit cannot be silently overwritten", async () => {
  const { files, backend, documents, external } = await conflictedDraft();
  await documents.requestSave();
  const read = backend.readFileSnapshot!;
  backend.readFileSnapshot = async (path) => {
    const result = await read(path);
    external("newer external");
    return result;
  };
  assert.equal(await documents.resolveConflict("overwrite"), false);
  assert.equal(files.text("a.md"), "newer external");
  assert.equal(active(documents).content, "draft");
  assert.equal(active(documents).dirty, true);
  assert.ok(documents.snapshot().conflictPrompt);
  assert.match(documents.snapshot().conflictError!, /修改/);
  await documents.close();
});

for (const [scenario, content] of [
  ["invalid UTF-8", new Uint8Array([255])],
  ["oversized text", new Uint8Array(MAX_EDITABLE_BYTES + 1)],
  ["missing file", null],
] as const) {
  test(`discard of ${scenario} keeps local edits and the save request open`, async () => {
    const { files, documents, external } = await conflictedDraft();
    await documents.requestSave();
    if (content) external(content);
    else files.files.delete(path("a.md"));
    assert.equal(await documents.resolveConflict("discard"), false);
    assert.equal(active(documents).content, "draft");
    assert.equal(active(documents).dirty, true);
    assert.equal(active(documents).reloadVersion, 0);
    assert.equal(documents.snapshot().conflictPrompt?.intent, "save");
    assert.ok(documents.snapshot().conflictError);
    await documents.close();
  });
}

test("discard cannot fabricate a replacement history after the file disappears", async () => {
  const { files, documents, external, id } = await conflictedDraft();
  await documents.requestCloseDocument(id);
  files.files.delete(path("a.md"));
  assert.equal(await documents.resolveConflict("discard"), false);
  assert.equal(active(documents).content, "draft");
  assert.ok(documents.snapshot().conflictPrompt);
  // Once a valid replacement exists, the same explicit discard can finish.
  external("replacement");
  assert.equal(await documents.resolveConflict("discard"), true);
  assert.equal(documents.has(id), false);
  assert.equal(files.text("a.md"), "replacement");
  await documents.close();
});

// Codec round trips belong to native core tests; here the boundary is that a
// clean view does not accidentally issue an IO write.
test("opening and saving a clean view does not rewrite the file", async () => {
  const { files, documents } = await create();
  await documents.open(path("a.md"));
  assert.equal(await documents.save(), true);
  assert.deepEqual(files.log, []);
  await documents.close();
});

test("rapid file opens use the latest request, and switching back retains the draft and document identity", async () => {
  const { files, documents } = await create();
  const started = deferred(),
    gate = deferred();
  files.onRead = async (key) => {
    if (key === path("a.md")) {
      started.resolve();
      await gate.promise;
    }
  };
  const first = documents.open(path("a.md"));
  await started.promise;
  const second = documents.open(path("b.ts"));
  gate.resolve();
  assert.equal(await first, false);
  assert.equal(await second, true);
  const id = active(documents).id;
  replaceText(documents, id, "const b = 2;");
  await documents.open(path("a.md"));
  await documents.open(path("b.ts"));
  assert.equal(active(documents).id, id);
  assert.equal(active(documents).content, "const b = 2;");
  const activation = documents.snapshot().activation;
  await documents.open(path("b.ts"));
  assert.ok(documents.snapshot().activation > activation);
  await documents.close();
});

test("edits during a pending save remain dirty until the newer version commits, with no parallel writes", async () => {
  const { files, documents } = await create();
  await documents.open(path("a.md"));
  const id = active(documents).id,
    started = deferred(),
    gate = deferred();
  let calls = 0,
    running = 0;
  files.onWrite = async () => {
    assert.equal(running++, 0);
    if (++calls === 1) {
      started.resolve();
      await gate.promise;
    }
    running--;
  };
  replaceText(documents, id, "version 1");
  const saving = documents.save(id);
  await started.promise;
  replaceText(documents, id, "version 2");
  assert.equal(active(documents).dirty, true);
  assert.equal(active(documents).saving, true);
  const nextSave = documents.save(id);
  gate.resolve();
  assert.equal(await saving, true);
  assert.equal(await nextSave, true);
  assert.equal(calls, 2);
  assert.equal(files.text("a.md"), "version 2");
  assert.equal(active(documents).dirty, false);
  await documents.close();
});

test("autosave persists edits without an explicit save and stops repeating after write failure", async () => {
  const files = new Files(),
    documents = (await createTestEditor(files)).documents;
  await documents.open(path("a.md"));
  const saved = deferred();
  files.onWrite = () => saved.resolve();
  replaceText(documents, active(documents).id, "automatic");
  await saved.promise;
  await documents.save();
  assert.equal(files.text("a.md"), "automatic");
  const failed = deferred();
  files.onWrite = () => {
    failed.resolve();
    throw new VaultError("QuotaExceeded", "full");
  };
  replaceText(documents, active(documents).id, "draft");
  await failed.promise;
  assert.equal(await documents.save(), false);
  const calls = files.log.length;
  replaceText(documents, active(documents).id, "new draft");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(files.log.length, calls);
  assert.equal(active(documents).dirty, true);
  files.onWrite = undefined;
  await documents.close();
});

test("failed saves preserve the buffer, refuse close and tree mutations, and allow switching and retrying", async () => {
  const { files, documents } = await create();
  await documents.open(path("a.md"));
  const id = active(documents).id;
  replaceText(documents, id, "unsaved");
  files.onWrite = () => {
    throw new VaultError("QuotaExceeded", "full");
  };
  assert.equal(await documents.save(), false);
  assert.equal(await documents.closeDocument(id), false);
  assert.match(active(documents).error!, /full/);
  assert.equal(active(documents).content, "unsaved");
  assert.equal(files.text("a.md"), "alpha");
  await assert.rejects(
    documents.treeBackend.rename(path("a.md"), path("new.md")),
    (error) => error instanceof VaultError && error.code === "QuotaExceeded",
  );
  await assert.rejects(documents.treeBackend.remove(path("a.md")));
  assert.ok(
    !files.log.some(
      (item) => item.startsWith("rename:") || item.startsWith("remove:"),
    ),
  );
  await documents.open(path("b.ts"));
  await documents.open(path("a.md"));
  assert.equal(active(documents).content, "unsaved");
  files.onWrite = undefined;
  assert.equal(await documents.save(), true);
  assert.equal(active(documents).error, null);
  assert.equal(files.text("a.md"), "unsaved");
  await documents.close();
});

test("directory rename drains pending saves, preserves document IDs and buffers, and future saves use the new paths", async () => {
  const { files, documents } = await create();
  files.file("folder/note.md", "old");
  await documents.open(path("folder/note.md"));
  const id = active(documents).id,
    started = deferred(),
    gate = deferred();
  files.onWrite = async () => {
    started.resolve();
    await gate.promise;
  };
  replaceText(documents, id, "new");
  const saving = documents.save();
  await started.promise;
  assert.equal(replaceText(documents, id, "newer"), true);
  const moving = documents.treeBackend.rename(path("folder"), path("renamed"));
  files.onRename = () => {
    assert.equal(active(documents).locked, true);
    assert.equal(replaceText(documents, id, "rejected"), false);
  };
  gate.resolve();
  await saving;
  await moving;
  assert.equal(active(documents).id, id);
  assert.equal(active(documents).path, "renamed/note.md");
  assert.equal(active(documents).content, "newer");
  assert.equal(files.text("renamed/note.md"), "newer");
  files.onWrite = undefined;
  replaceText(documents, id, "after rename");
  await documents.save();
  assert.equal(files.text("renamed/note.md"), "after rename");
  assert.equal(files.files.has(path("folder/note.md")), false);
  await documents.close();
});

test("file tree copying reads current edits and deleting a directory closes affected documents without recreating files", async () => {
  const { files, documents } = await create();
  await documents.open(path("a.md"));
  replaceText(documents, active(documents).id, "copied edits");
  const tree = new FileTreeModel(documents.treeBackend);
  await tree.refresh();
  assert.equal(await tree.copy([path("a.md")], path("folder")), true);
  assert.equal(files.text("folder/a.md"), "copied edits");
  await documents.open(path("folder/a.md"));
  replaceText(documents, active(documents).id, "delete edits");
  assert.equal(await tree.remove([path("folder")]), true);
  assert.equal(documents.snapshot().documents.length, 1);
  assert.equal(active(documents).path, "a.md");
  await documents.saveAll();
  assert.equal(files.files.has(path("folder/a.md")), false);
  assert.ok(
    files.log.indexOf("write:folder/a.md:delete edits") <
      files.log.indexOf("remove:folder"),
  );
  tree.dispose();
  await documents.close();
});

for (const [key, content] of [
  ["null.bin", new Uint8Array([1, 0, 2])],
  ["bad.bin", new Uint8Array([255])],
  ["large.txt", new Uint8Array(MAX_EDITABLE_BYTES + 1)],
] as const) {
  test(`read-only ${key} cannot be modified or saved`, async () => {
    const { files, documents } = await create();
    files.file(key, content);
    await documents.open(path(key));
    assert.ok(active(documents).readOnlyReason);
    assert.equal(replaceText(documents, active(documents).id, "wrong"), false);
    assert.equal(await documents.save(), false);
    assert.deepEqual(files.files.get(path(key)), content);
    assert.deepEqual(files.log, []);
    await documents.close();
  });
}

test("an externally deleted file is never recreated by autosave, and an open failure preserves the current document", async () => {
  const { files, documents } = await create();
  await documents.open(path("a.md"));
  const id = active(documents).id;
  files.files.delete(path("a.md"));
  replaceText(documents, id, "draft after deletion");
  assert.equal(await documents.save(), false);
  assert.equal(files.files.has(path("a.md")), false);
  assert.equal(active(documents).content, "draft after deletion");
  assert.equal(await documents.open(path("missing.md")), false);
  assert.equal(active(documents).id, id);
  assert.ok(documents.snapshot().openError);
  await documents.close();
});

test("shutdown flushes outstanding edits before closing the backend and rejects new operations", async () => {
  const { files, documents } = await create();
  await documents.open(path("a.md"));
  const id = active(documents).id;
  replaceText(documents, id, "last changes");
  const closing = documents.close();
  assert.equal(replaceText(documents, id, "too late"), false);
  await assert.rejects(
    documents.treeBackend.remove(path("a.md")),
    (error) => error instanceof VaultError && error.code === "Closed",
  );
  await closing;
  assert.equal(files.text("a.md"), "last changes");
  assert.equal(files.log.slice(-1)[0], "close");
  assert.equal(files.closed, true);
  assert.equal(documents.hasUnsaved(), false);
});

test("unrelated reads cannot advance a document save baseline", async () => {
  const { files, backend, documents, external, written } = await versioned();
  await documents.open(path("a.md"));
  external("external");
  assert.equal(
    new TextDecoder().decode(
      (await backend.readFileSnapshot!(path("a.md"))).data,
    ),
    "external",
  );
  replaceText(documents, documents.snapshot().activeId!, "my changes");
  assert.equal(await documents.save(), false);
  assert.deepEqual(
    written,
    [],
    "the stale baseline must be rejected before writing",
  );
  assert.equal(files.text("a.md"), "external");
  assert.equal(documents.hasUnsaved(), true);
  await documents.close();
});
