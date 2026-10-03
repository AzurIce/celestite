import { test } from "node:test";
import assert from "node:assert/strict";
import {
  VaultDocuments,
  MAX_EDITABLE_BYTES,
  decodeText,
  encodeText,
} from "../../src/lib/editor/documents";
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
  async writeFile(
    key: VaultPath,
    content: Uint8Array,
    options: WriteFileOptions,
  ) {
    this.log.push(`write:${key}:${new TextDecoder().decode(content)}`);
    await this.onWrite?.(key, content);
    if (options.mode === "replace" && !this.files.has(key))
      throw new VaultError("NotFound", "missing", key);
    if (options.mode === "create" && this.files.has(key))
      throw new VaultError("AlreadyExists", "exists", key);
    this.files.set(key, content.slice());
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
const active = (documents: VaultDocuments) =>
  documents
    .snapshot()
    .documents.find((record) => record.id === documents.snapshot().activeId)!;
const create = () => {
  const files = new Files();
  return { files, documents: new VaultDocuments(files, 60_000) };
};

function versioned() {
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
    documents: new VaultDocuments(backend, 60_000),
    external(text: string | Uint8Array) {
      files.file("a.md", text);
      version++;
    },
  };
}

test("background conflicts do not prompt, and cancel preserves disk and draft", async () => {
  const { files, documents, external } = versioned();
  await documents.open(path("a.md"));
  const id = active(documents).id;
  external("external");
  documents.update(id, "draft");
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
  const { files, documents, external, written } = versioned();
  await documents.open(path("a.md"));
  external("external");
  documents.update(active(documents).id, "draft");
  await documents.requestSave();
  assert.equal(await documents.resolveConflict("overwrite"), true);
  assert.deepEqual(written, ["0", "1"]);
  assert.equal(files.text("a.md"), "draft");
  assert.equal(active(documents).dirty, false);
  assert.equal(active(documents).conflict, false);
  documents.update(active(documents).id, "next edit");
  assert.equal(await documents.requestSave(), true);
  assert.deepEqual(written, ["0", "1", "2"]);
  await documents.close();
});

test("discard reloads latest text, encoding and view generation without rewriting disk", async () => {
  const { files, documents, external, written } = versioned();
  await documents.open(path("a.md"));
  external("external one");
  documents.update(active(documents).id, "draft");
  await documents.requestSave();
  external("\ufefflatest\r\nversion\r\n");
  assert.equal(await documents.resolveConflict("discard"), true);
  assert.equal(active(documents).content, "latest\nversion\n");
  assert.equal(active(documents).lineEnding, "\r\n");
  assert.equal(active(documents).bom, true);
  assert.equal(active(documents).reloadVersion, 1);
  assert.equal(active(documents).dirty, false);
  assert.deepEqual(written, ["0"]);
  assert.deepEqual(
    files.files.get(path("a.md")),
    bytes("\ufefflatest\r\nversion\r\n"),
  );
  documents.update(active(documents).id, "after reload\n");
  assert.equal(await documents.save(), true);
  assert.equal(written[1], "2");
  await documents.close();
});

test("overwrite and discard both finish the original close request", async () => {
  for (const action of ["overwrite", "discard"] as const) {
    const { files, documents, external } = versioned();
    await documents.open(path("a.md"));
    const id = active(documents).id;
    external("external");
    documents.update(id, "draft");
    assert.equal(await documents.requestCloseDocument(id), false);
    assert.equal(await documents.resolveConflict(action), true);
    assert.equal(documents.has(id), false);
    assert.equal(
      files.text("a.md"),
      action === "overwrite" ? "draft" : "external",
    );
    await documents.close();
  }
});

test("another edit between conflict reread and commit cannot be silently overwritten", async () => {
  const { files, backend, documents, external } = versioned();
  await documents.open(path("a.md"));
  external("external");
  documents.update(active(documents).id, "draft");
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
  assert.match(documents.snapshot().conflictError!, /再次发生变化/);
  await documents.close();
});

test("failed or invalid reload keeps local edits and the save request open", async () => {
  for (const content of [
    new Uint8Array([255]),
    new Uint8Array(MAX_EDITABLE_BYTES + 1),
    null,
  ]) {
    const { files, documents, external } = versioned();
    await documents.open(path("a.md"));
    external("external");
    documents.update(active(documents).id, "draft");
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
  }
});

test("discard on close never depends on the file still existing or being text", async () => {
  const { files, documents, external } = versioned();
  await documents.open(path("a.md"));
  const id = active(documents).id;
  external("external");
  documents.update(id, "draft");
  await documents.requestCloseDocument(id);
  files.files.delete(path("a.md"));
  assert.equal(await documents.resolveConflict("discard"), true);
  assert.equal(documents.has(id), false);
  assert.equal(files.files.has(path("a.md")), false);
  await documents.close();
});

test("UTF-8 BOM and existing CRLF/CR survive editing, and clean opens do not rewrite files", async () => {
  for (const ending of ["\r\n", "\r", "\n"] as const) {
    const original = bytes(`\ufeffhello${ending}世界${ending}`);
    const decoded = decodeText(original);
    assert.equal(decoded.content, "hello\n世界\n");
    assert.equal(decoded.lineEnding, ending);
    assert.deepEqual(encodeText(decoded), original);
  }
  const { files, documents } = create();
  files.file("a.md", bytes("\ufeffalpha\r\n"));
  await documents.open(path("a.md"));
  assert.equal(active(documents).bom, true);
  await documents.save();
  assert.deepEqual(files.log, []);
  documents.update(active(documents).id, "beta\n世界\n");
  assert.equal(await documents.save(), true);
  assert.deepEqual(
    files.files.get(path("a.md")),
    bytes("\ufeffbeta\r\n世界\r\n"),
  );
  assert.equal(active(documents).dirty, false);
  await documents.close();
});

test("rapid file opens use the latest request, and switching back retains the draft and document identity", async () => {
  const { files, documents } = create();
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
  documents.update(id, "const b = 2;");
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
  const { files, documents } = create();
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
  documents.update(id, "version 1");
  const saving = documents.save(id);
  await started.promise;
  documents.update(id, "version 2");
  assert.equal(active(documents).dirty, true);
  assert.equal(active(documents).saving, true);
  assert.equal(documents.save(id), saving);
  gate.resolve();
  assert.equal(await saving, true);
  assert.equal(calls, 2);
  assert.equal(files.text("a.md"), "version 2");
  assert.equal(active(documents).dirty, false);
  await documents.close();
});

test("autosave persists edits without an explicit save and stops repeating after write failure", async () => {
  const files = new Files(),
    documents = new VaultDocuments(files, 5);
  await documents.open(path("a.md"));
  const saved = deferred();
  files.onWrite = () => saved.resolve();
  documents.update(active(documents).id, "automatic");
  await saved.promise;
  await documents.save();
  assert.equal(files.text("a.md"), "automatic");
  const failed = deferred();
  files.onWrite = () => {
    failed.resolve();
    throw new VaultError("QuotaExceeded", "full");
  };
  documents.update(active(documents).id, "draft");
  await failed.promise;
  assert.equal(await documents.save(), false);
  const calls = files.log.length;
  documents.update(active(documents).id, "new draft");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(files.log.length, calls);
  assert.equal(active(documents).dirty, true);
  files.onWrite = undefined;
  await documents.close();
});

test("failed saves preserve the buffer, refuse close and tree mutations, and allow switching and retrying", async () => {
  const { files, documents } = create();
  await documents.open(path("a.md"));
  const id = active(documents).id;
  documents.update(id, "unsaved");
  files.onWrite = () => {
    throw new VaultError("QuotaExceeded", "full");
  };
  assert.equal(await documents.save(), false);
  assert.equal(await documents.closeDocument(id), false);
  assert.match(active(documents).error!, /空间不足/);
  assert.equal(active(documents).content, "unsaved");
  assert.equal(files.text("a.md"), "alpha");
  await assert.rejects(
    documents.treeBackend.rename(path("a.md"), path("new.md")),
    (error) => error instanceof VaultError && error.code === "IO",
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
  const { files, documents } = create();
  files.file("folder/note.md", "old");
  await documents.open(path("folder/note.md"));
  const id = active(documents).id,
    started = deferred(),
    gate = deferred();
  files.onWrite = async () => {
    started.resolve();
    await gate.promise;
  };
  documents.update(id, "new");
  const saving = documents.save();
  await started.promise;
  const moving = documents.treeBackend.rename(path("folder"), path("renamed"));
  documents.update(id, "newer");
  files.onRename = () => {
    assert.equal(active(documents).locked, true);
    assert.equal(documents.update(id, "rejected"), false);
  };
  gate.resolve();
  await saving;
  await moving;
  assert.equal(active(documents).id, id);
  assert.equal(active(documents).path, "renamed/note.md");
  assert.equal(active(documents).content, "newer");
  assert.equal(files.text("renamed/note.md"), "newer");
  files.onWrite = undefined;
  documents.update(id, "after rename");
  await documents.save();
  assert.equal(files.text("renamed/note.md"), "after rename");
  assert.equal(files.files.has(path("folder/note.md")), false);
  await documents.close();
});

test("file tree copying reads current edits and deleting a directory closes affected documents without recreating files", async () => {
  const { files, documents } = create();
  await documents.open(path("a.md"));
  documents.update(active(documents).id, "copied edits");
  const tree = new FileTreeModel(documents.treeBackend);
  await tree.refresh();
  assert.equal(await tree.copy([path("a.md")], path("folder")), true);
  assert.equal(files.text("folder/a.md"), "copied edits");
  await documents.open(path("folder/a.md"));
  documents.update(active(documents).id, "delete edits");
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

test("binary, invalid UTF-8 and oversized files cannot be modified or saved", async () => {
  const { files, documents } = create();
  for (const [key, content] of [
    ["null.bin", new Uint8Array([1, 0, 2])],
    ["bad.bin", new Uint8Array([255])],
    ["large.txt", new Uint8Array(MAX_EDITABLE_BYTES + 1)],
  ] as const) {
    files.file(key, content);
    await documents.open(path(key));
    assert.ok(active(documents).readOnlyReason);
    assert.equal(documents.update(active(documents).id, "wrong"), false);
    assert.equal(await documents.save(), false);
    assert.deepEqual(files.files.get(path(key)), content);
  }
  assert.deepEqual(files.log, []);
  await documents.close();
});

test("an externally deleted file is never recreated by autosave, and an open failure preserves the current document", async () => {
  const { files, documents } = create();
  await documents.open(path("a.md"));
  const id = active(documents).id;
  files.files.delete(path("a.md"));
  documents.update(id, "draft after deletion");
  assert.equal(await documents.save(), false);
  assert.equal(files.files.has(path("a.md")), false);
  assert.equal(active(documents).content, "draft after deletion");
  assert.equal(await documents.open(path("missing.md")), false);
  assert.equal(active(documents).id, id);
  assert.ok(documents.snapshot().openError);
  await documents.close();
});

test("shutdown flushes outstanding edits before closing the backend and rejects new operations", async () => {
  const { files, documents } = create();
  await documents.open(path("a.md"));
  const id = active(documents).id;
  documents.update(id, "last changes");
  const closing = documents.close();
  assert.equal(documents.update(id, "too late"), false);
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

test("a read-only Vault opens text without accepting edits", async () => {
  const backend = new Files();
  const documents = new VaultDocuments(backend, 800, true);
  await documents.open(path("a.md"));
  const file = documents.snapshot().documents[0];
  assert.equal(file.content, "alpha");
  assert.equal(file.readOnlyReason, "当前 Vault 只读。");
  assert.equal(documents.update(file.id, "changed"), false);
  assert.equal(documents.hasUnsaved(), false);
  await documents.close();
});

test("unrelated reads cannot advance a document save baseline", async () => {
  const files = new Files();
  const backend: VaultBackend = files;
  let version = "initial";
  backend.readFileSnapshot = async (path) => ({
    data: await files.readFile(path),
    revision: version,
  });
  const originalWrite = files.writeFile.bind(files);
  const expected: string[] = [];
  backend.writeFile = async (path, data, options) => {
    expected.push(options.expectedRevision!);
    if (options.expectedRevision !== version)
      throw new VaultError("Conflict", "changed");
    await originalWrite(path, data, options);
    version = "saved";
    return version;
  };
  const documents = new VaultDocuments(backend);
  await documents.open(path("a.md"));
  files.file("a.md", "external");
  version = "external";
  assert.equal(
    new TextDecoder().decode(
      await documents.treeBackend.readFile(path("a.md")),
    ),
    "external",
  );
  documents.update(documents.snapshot().activeId!, "my changes");
  assert.equal(await documents.save(), false);
  assert.deepEqual(expected, ["initial"]);
  assert.equal(files.text("a.md"), "external");
  assert.equal(documents.hasUnsaved(), true);
  await documents.close();
});
