import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FileTreeModel,
  topLevelPaths,
  parentPath,
} from "../../src/lib/file-tree/model";
import type { TreeChange } from "../../src/lib/file-tree/model";
import {
  ROOT_PATH,
  vaultPath,
  VaultError,
  VaultRenameError,
} from "../../src/lib/vault";
import type {
  Entry,
  VaultBackend,
  VaultPath,
  WriteFileOptions,
} from "../../src/lib/vault";

class MemoryBackend implements VaultBackend {
  entries = new Map<VaultPath, Entry>([
    [ROOT_PATH, { path: ROOT_PATH, kind: "directory" }],
  ]);
  contents = new Map<VaultPath, Uint8Array>();
  reads: VaultPath[] = [];
  mutations: string[] = [];
  onRename?: (from: VaultPath, to: VaultPath) => void | Promise<void>;
  onWrite?: (path: VaultPath) => void;
  dir(path: string) {
    const key = vaultPath(path);
    this.entries.set(key, { path: key, kind: "directory" });
    return this;
  }
  file(path: string, bytes = [1]) {
    const key = vaultPath(path);
    this.entries.set(key, { path: key, kind: "file" });
    this.contents.set(key, new Uint8Array(bytes));
    return this;
  }
  async *readDir(path: VaultPath) {
    this.reads.push(path);
    if (this.entries.get(path)?.kind !== "directory")
      throw new VaultError("NotDirectory", "Not a directory");
    for (const entry of this.entries.values())
      if (entry.path !== ROOT_PATH && parentPath(entry.path) === path)
        yield entry;
  }
  async stat(path: VaultPath) {
    return this.entries.get(path) ?? null;
  }
  async readFile(path: VaultPath) {
    const bytes = this.contents.get(path);
    if (!bytes) throw new VaultError("NotFound", "Missing file");
    return bytes.slice();
  }
  async writeFile(
    path: VaultPath,
    bytes: Uint8Array,
    options: WriteFileOptions,
  ) {
    this.onWrite?.(path);
    if (options.mode === "create" && this.entries.has(path))
      throw new VaultError("AlreadyExists", "Exists");
    this.mutations.push(`write:${path}`);
    this.file(path, Array.from(bytes));
  }
  async mkdir(path: VaultPath) {
    if (this.entries.has(path)) throw new VaultError("AlreadyExists", "Exists");
    this.mutations.push(`mkdir:${path}`);
    this.dir(path);
  }
  async remove(path: VaultPath) {
    this.mutations.push(`remove:${path}`);
    for (const key of [...this.entries.keys()])
      if (key === path || key.startsWith(`${path}/`)) {
        this.entries.delete(key);
        this.contents.delete(key);
      }
  }
  async rename(from: VaultPath, to: VaultPath) {
    this.mutations.push(`rename:${from}:${to}`);
    await this.onRename?.(from, to);
    if (!this.entries.has(from))
      throw new VaultError("NotFound", "Missing source");
    if (this.entries.has(to)) throw new VaultError("AlreadyExists", "Exists");
    for (const [path, entry] of [...this.entries]) {
      if (path !== from && !path.startsWith(`${from}/`)) continue;
      const next = vaultPath(to + path.slice(from.length));
      this.entries.delete(path);
      this.entries.set(next, { ...entry, path: next });
      const bytes = this.contents.get(path);
      if (bytes) {
        this.contents.delete(path);
        this.contents.set(next, bytes);
      }
    }
  }
  async watch() {
    return () => {};
  }
  async close() {}
}
const paths = (values: readonly string[]) => values.map(vaultPath);
const selected = (model: FileTreeModel) => [...model.snapshot().selected];

test("directories are lazy, sorted before files, and rows expose hierarchy metadata", async () => {
  const backend = new MemoryBackend()
    .file("z.md")
    .dir("notes")
    .file("a10.md")
    .file("a2.md")
    .file("notes/a.md")
    .dir("notes/empty");
  const model = new FileTreeModel(backend);
  await model.refresh();
  assert.deepEqual(backend.reads, [ROOT_PATH]);
  assert.deepEqual(
    model.snapshot().rows.map((row) => row.path),
    ["notes", "a2.md", "a10.md", "z.md"],
  );
  await model.toggle(vaultPath("notes"));
  const child = model.snapshot().byPath.get(vaultPath("notes/a.md"));
  assert.equal(child?.level, 2);
  assert.equal(child?.position, 2);
  assert.equal(child?.siblings, 2);
  assert.deepEqual(model.snapshot().groups.get(vaultPath("notes")), [
    "notes/empty",
    "notes/a.md",
  ]);
});

test("toggle, range, additive range and focus-only selection use the visible order and stable anchor", async () => {
  const model = new FileTreeModel(
    new MemoryBackend().file("a").file("b").file("c").file("d"),
  );
  await model.refresh();
  model.select(vaultPath("a"));
  model.select(vaultPath("c"), { toggle: true });
  assert.deepEqual(selected(model), ["a", "c"]);
  model.select(vaultPath("b"), { range: true });
  assert.deepEqual(selected(model), ["b", "c"]);
  model.select(vaultPath("a"));
  model.select(vaultPath("c"), { focusOnly: true });
  assert.deepEqual(selected(model), ["a"]);
  model.select(vaultPath("d"), { range: true });
  assert.deepEqual(selected(model), ["a", "b", "c", "d"]);
  model.contextSelect(vaultPath("b"));
  assert.equal(selected(model).length, 4);
  model.select(vaultPath("a"));
  model.select(vaultPath("d"), { toggle: true });
  model.select(vaultPath("c"), { range: true, toggle: true });
  assert.deepEqual(new Set(selected(model)), new Set(["a", "c", "d"]));
  model.select(vaultPath("c"), { toggle: true });
  assert.deepEqual(selected(model), ["a", "d"]);
  model.selectAll();
  assert.equal(selected(model).length, 4);
  model.clearSelection();
  assert.equal(selected(model).length, 0);
});

test("collapse removes hidden selections and moves focus to the visible parent", async () => {
  const model = new FileTreeModel(
    new MemoryBackend().dir("d").file("d/a").file("d/b"),
  );
  await model.refresh();
  await model.toggle(vaultPath("d"));
  model.select(vaultPath("d/a"));
  model.select(vaultPath("d/b"), { toggle: true });
  await model.toggle(vaultPath("d"));
  assert.deepEqual(selected(model), ["d"]);
  assert.equal(model.snapshot().focused, "d");
});

test("batch target conflicts and duplicate basenames are rejected before any mutation", async () => {
  const backend = new MemoryBackend()
    .file("a")
    .file("b")
    .dir("target")
    .file("target/b");
  const model = new FileTreeModel(backend);
  await model.refresh();
  assert.equal(await model.move(paths(["a", "b"]), vaultPath("target")), false);
  assert.equal(backend.mutations.length, 0);
  assert.ok(backend.entries.has(vaultPath("a")));
  backend.dir("d1").dir("d2").file("d1/same").file("d2/same");
  assert.equal(
    await model.move(paths(["d1/same", "d2/same"]), vaultPath("target")),
    false,
  );
  assert.equal(backend.mutations.length, 0);
  assert.match(model.snapshot().error!, /已存在/);
});

test("moving selected ancestors and descendants moves the subtree once and preserves expansion", async () => {
  const backend = new MemoryBackend()
    .dir("notes")
    .dir("notes/sub")
    .file("notes/sub/a")
    .dir("target");
  const model = new FileTreeModel(backend);
  await model.refresh();
  await model.toggle(vaultPath("notes"));
  await model.toggle(vaultPath("notes/sub"));
  model.select(vaultPath("notes"));
  model.select(vaultPath("notes/sub/a"), { toggle: true });
  assert.deepEqual(topLevelPaths(selected(model)), ["notes"]);
  assert.equal(model.canMove(model.selection(), vaultPath("notes/sub")), false);
  assert.equal(await model.move(model.selection(), vaultPath("target")), true);
  assert.deepEqual(backend.mutations, ["rename:notes:target/notes"]);
  assert.ok(model.snapshot().expanded.has(vaultPath("target/notes/sub")));
  assert.ok(model.snapshot().byPath.has(vaultPath("target/notes/sub/a")));
  assert.ok(model.snapshot().selected.has(vaultPath("target/notes/sub/a")));
});

test("partial batch failures reload the real tree and report completed items and rename stage", async () => {
  const backend = new MemoryBackend().file("a").file("b").dir("target");
  const changes: TreeChange[] = [];
  const model = new FileTreeModel(backend, (change) => changes.push(change));
  await model.refresh();
  backend.onRename = (from, to) => {
    if (from === "b") {
      backend.file(to, [1]);
      throw new VaultRenameError(
        new VaultError("Busy", "Source deletion failed"),
        from,
        to,
        "remove-source",
      );
    }
  };
  assert.equal(await model.move(paths(["a", "b"]), vaultPath("target")), false);
  assert.equal(changes.length, 1);
  assert.ok(model.snapshot().byPath.has(vaultPath("target/a")));
  assert.ok(model.snapshot().byPath.has(vaultPath("target/b")));
  assert.ok(model.snapshot().byPath.has(vaultPath("b")));
  assert.match(model.snapshot().error!, /已完成 1 项/);
  assert.match(model.snapshot().error!, /完整目标已保留/);
  assert.equal(model.snapshot().busy, false);
});

test("cut/paste uses captured paths, clears successful cuts and treats same-directory paste as a no-op", async () => {
  const backend = new MemoryBackend().file("a").file("b").dir("target");
  const model = new FileTreeModel(backend);
  await model.refresh();
  model.select(vaultPath("a"));
  model.cutSelection();
  model.select(vaultPath("b"));
  assert.equal(await model.paste(vaultPath("target")), true);
  assert.ok(backend.entries.has(vaultPath("b")));
  assert.ok(backend.entries.has(vaultPath("target/a")));
  assert.equal(model.snapshot().cut.size, 0);
  model.select(vaultPath("b"));
  model.cutSelection();
  assert.equal(await model.paste(ROOT_PATH), true);
  assert.equal(model.snapshot().cut.size, 0);
  assert.equal(backend.mutations.length, 1);
  model.select(vaultPath("target/a"));
  model.cutSelection();
  model.clearSelection(true);
  assert.equal(model.directoryFor(), ROOT_PATH);
  assert.equal(await model.paste(model.directoryFor()), true);
  assert.ok(backend.entries.has(vaultPath("a")));
});

test("deleting a parent and child removes once; rename and creation reveal updated paths", async () => {
  const backend = new MemoryBackend().dir("notes").file("notes/a");
  const model = new FileTreeModel(backend);
  await model.refresh();
  await model.toggle(vaultPath("notes"));
  await model.rename(vaultPath("notes"), "docs");
  assert.ok(model.snapshot().expanded.has(vaultPath("docs")));
  await model.create(vaultPath("docs"), "b", "file");
  assert.deepEqual(selected(model), ["docs/b"]);
  assert.equal(await model.create(ROOT_PATH, "../outside", "file"), false);
  await model.remove(paths(["docs", "docs/a", "docs/b"]));
  assert.equal(
    backend.mutations.filter((operation) => operation.startsWith("remove:"))
      .length,
    1,
  );
  assert.equal(model.snapshot().rows.length, 0);
});

test("file import preflights every name and preserves binary bytes", async () => {
  const backend = new MemoryBackend().dir("target").file("target/existing");
  const model = new FileTreeModel(backend);
  await model.refresh();
  assert.equal(
    await model.importFiles(
      [new File(["new"], "new"), new File(["collision"], "existing")],
      vaultPath("target"),
    ),
    false,
  );
  assert.equal(backend.mutations.length, 0);
  assert.equal(
    await model.importFiles(
      [new File([new Uint8Array([0, 255])], "中文.bin")],
      vaultPath("target"),
    ),
    true,
  );
  assert.deepEqual(
    Array.from(backend.contents.get(vaultPath("target/中文.bin"))!),
    [0, 255],
  );
  assert.deepEqual(selected(model), ["target/中文.bin"]);
});

test("busy state prevents overlapping operations, and dispose suppresses late notifications", async () => {
  const backend = new MemoryBackend().file("a").dir("target");
  const model = new FileTreeModel(backend);
  await model.refresh();
  let resume!: () => void;
  backend.onRename = () =>
    new Promise<void>((resolve) => {
      resume = resolve;
    });
  const pending = model.move(paths(["a"]), vaultPath("target"));
  while (!resume) await Promise.resolve();
  assert.equal(model.snapshot().busy, true);
  assert.equal(await model.create(ROOT_PATH, "blocked", "file"), false);
  let notifications = 0;
  model.subscribe(() => {
    notifications++;
  });
  model.dispose();
  resume();
  await pending;
  assert.equal(notifications, 0);
  assert.ok(!backend.entries.has(vaultPath("blocked")));
});

test("copy/paste copies nested directories once, keeps the originals and generates collision-free sibling copies", async () => {
  const backend = new MemoryBackend()
    .dir("notes")
    .dir("notes/empty")
    .file("notes/a.md", [0, 255])
    .dir("target");
  const model = new FileTreeModel(backend);
  await model.refresh();
  await model.toggle(vaultPath("notes"));
  model.select(vaultPath("notes"));
  model.select(vaultPath("notes/a.md"), { toggle: true });
  model.copySelection();
  assert.equal(model.snapshot().cut.size, 0);
  assert.equal(await model.paste(vaultPath("target")), true);
  assert.ok(backend.entries.has(vaultPath("notes/a.md")));
  assert.ok(backend.entries.has(vaultPath("target/notes/empty")));
  assert.deepEqual(
    Array.from(backend.contents.get(vaultPath("target/notes/a.md"))!),
    [0, 255],
  );
  assert.equal(model.snapshot().clipboard.count, 1);
  assert.equal(await model.paste(ROOT_PATH), true);
  assert.ok(backend.entries.has(vaultPath("notes 副本/a.md")));
  assert.equal(await model.paste(ROOT_PATH), true);
  assert.ok(backend.entries.has(vaultPath("notes 副本 2/a.md")));
});

test("copy failure keeps originals and visible partial targets without risky automatic deletion", async () => {
  const backend = new MemoryBackend()
    .dir("notes")
    .file("notes/a")
    .file("notes/b")
    .dir("target");
  const model = new FileTreeModel(backend);
  await model.refresh();
  backend.onWrite = (path) => {
    if (path === "target/notes/b")
      throw new VaultError("QuotaExceeded", "Injected failure");
  };
  assert.equal(await model.copy(paths(["notes"]), vaultPath("target")), false);
  assert.ok(backend.entries.has(vaultPath("notes/a")));
  assert.ok(backend.entries.has(vaultPath("notes/b")));
  assert.ok(backend.entries.has(vaultPath("target/notes/a")));
  assert.equal(
    backend.mutations.filter((operation) => operation.startsWith("remove:"))
      .length,
    0,
  );
  assert.match(model.snapshot().error!, /源未修改/);
});

test("external invalidation waits for active IO and does not hide a partial-operation error", async () => {
  const backend = new MemoryBackend().file("a").dir("target");
  const model = new FileTreeModel(backend);
  await model.refresh();
  let resume!: () => void;
  backend.onRename = async (from, to) => {
    await new Promise<void>((resolve) => {
      resume = resolve;
    });
    backend.file(to);
    throw new VaultRenameError(
      new VaultError("Busy", "Injected failure"),
      from,
      to,
      "remove-source",
    );
  };
  const operation = model.move(paths(["a"]), vaultPath("target"));
  while (!resume) await Promise.resolve();
  model.invalidate();
  resume();
  await operation;
  for (let i = 0; i < 50 && model.snapshot().busy; i++) await Promise.resolve();
  assert.equal(model.snapshot().busy, false);
  assert.match(model.snapshot().error!, /完整目标已保留/);
  assert.ok(model.snapshot().byPath.has(vaultPath("a")));
});
