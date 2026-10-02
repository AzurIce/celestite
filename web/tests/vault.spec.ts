import { expect, test } from "@playwright/test";

type VaultModule = typeof import("../src/lib/vault");

test.beforeEach(async ({ page }) => {
  await page.goto("/");
});

test("default Vault preserves text, binary files and empty directories across reloads", async ({ page }) => {
  const events = await page.evaluate(async () => {
    const url = "/src/lib/vault/index.ts";
    const { openOpfsVault, vaultPath } = await import(url) as VaultModule;
    const backend = await openOpfsVault();
    let events = 0;
    const unwatch = await backend.watch(() => { events++; });
    await backend.mkdir(vaultPath("notes/empty"), { recursive: true });
    await backend.writeFile(vaultPath("notes/中文.md"), new TextEncoder().encode("你好，Vault！"), { mode: "create" });
    await backend.writeFile(vaultPath("binary"), new Uint8Array([0, 255, 128, 10]), { mode: "create" });
    unwatch();
    unwatch();
    await backend.close();
    unwatch();
    return events;
  });
  expect(events).toBe(0);
  await page.reload();
  const result = await page.evaluate(async () => {
    const url = "/src/lib/vault/index.ts";
    const { openOpfsVault, vaultPath, ROOT_PATH } = await import(url) as VaultModule;
    const backend = await openOpfsVault();
    const entries = [];
    for await (const entry of backend.readDir(vaultPath("notes"))) entries.push(entry);
    const result = {
      text: new TextDecoder().decode(await backend.readFile(vaultPath("notes/中文.md"))),
      bytes: Array.from(await backend.readFile(vaultPath("binary"))),
      entries: entries.sort((a, b) => a.path.localeCompare(b.path)),
      stat: await backend.stat(vaultPath("binary")),
      root: await backend.stat(ROOT_PATH),
      absent: await backend.stat(vaultPath("missing/child")),
    };
    await backend.close();
    return result;
  });
  expect(result).toEqual({
    text: "你好，Vault！",
    bytes: [0, 255, 128, 10],
    entries: [
      { path: "notes/empty", kind: "directory" },
      { path: "notes/中文.md", kind: "file" },
    ],
    stat: { path: "binary", kind: "file", size: 4, modifiedAt: expect.any(Number) },
    root: { path: "", kind: "directory" },
    absent: null,
  });
});

test("create and replace have distinct semantics and replacing shorter contents truncates", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const url = "/src/lib/vault/index.ts";
    const { openOpfsVault, vaultPath, ROOT_PATH, VaultError } = await import(url) as VaultModule;
    const backend = await openOpfsVault();
    const path = vaultPath("note.md");
    const errors: string[] = [];
    const check = async (operation: () => Promise<unknown>) => {
      try { await operation(); errors.push("unexpected success"); }
      catch (error) { errors.push(error instanceof VaultError ? error.code : "unmapped error"); }
    };
    await backend.writeFile(path, new Uint8Array([1, 2, 3, 4]), { mode: "create" });
    await check(() => backend.writeFile(path, new Uint8Array([9]), { mode: "create" }));
    const unchanged = Array.from(await backend.readFile(path));
    await backend.writeFile(path, new Uint8Array([5]), { mode: "replace" });
    const shorter = Array.from(await backend.readFile(path));
    await backend.writeFile(path, new Uint8Array(), { mode: "replace" });
    const empty = Array.from(await backend.readFile(path));
    await check(() => backend.writeFile(vaultPath("missing"), new Uint8Array(), { mode: "replace" }));
    await check(() => backend.writeFile(vaultPath("missing/child"), new Uint8Array(), { mode: "create" }));
    await check(() => backend.readFile(ROOT_PATH));
    await backend.mkdir(vaultPath("directory"));
    await check(() => backend.writeFile(vaultPath("directory"), new Uint8Array(), { mode: "replace" }));
    await check(() => backend.stat(vaultPath("note.md/child")));
    await backend.close();
    return { errors, unchanged, shorter, empty };
  });
  expect(result).toEqual({
    errors: ["AlreadyExists", "NotFound", "NotFound", "NotFile", "NotFile", "NotDirectory"],
    unchanged: [1, 2, 3, 4], shorter: [5], empty: [],
  });
});

test("validates paths, protects root and requires explicit recursive directory operations", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const url = "/src/lib/vault/index.ts";
    const { openOpfsVault, vaultPath, ROOT_PATH, VaultError } = await import(url) as VaultModule;
    const backend = await openOpfsVault();
    const errors: string[] = [];
    const check = async (operation: () => unknown) => {
      try { await operation(); errors.push("unexpected success"); }
      catch (error) { errors.push(error instanceof VaultError ? error.code : "unmapped error"); }
    };
    for (const path of ["/absolute", "../outside", "a/../b", "a/./b", "a//b", "a/", "a\\b", "a\0b", "C:/outside"]) {
      await check(() => vaultPath(path));
    }
    // 即使调用者通过断言绕过品牌类型，后端仍须校验。
    await check(() => backend.readFile("../outside" as Parameters<typeof backend.readFile>[0]));
    await check(() => openOpfsVault("a/b"));
    await check(() => backend.remove(ROOT_PATH, { recursive: true }));
    await check(() => backend.mkdir(vaultPath("missing/child")));
    await backend.mkdir(vaultPath("a/b"), { recursive: true });
    await backend.mkdir(vaultPath("a/b"), { recursive: true });
    await check(() => backend.mkdir(vaultPath("a/b")));
    await check(() => backend.remove(vaultPath("a")));
    await backend.remove(vaultPath("a"), { recursive: true });
    const absent = await backend.stat(vaultPath("a"));
    await check(() => backend.remove(vaultPath("a")));
    await backend.close();
    return { errors, absent };
  });
  expect(result).toEqual({
    errors: [
      ...Array<string>(12).fill("InvalidPath"),
      "NotFound", "AlreadyExists", "DirectoryNotEmpty", "NotFound",
    ],
    absent: null,
  });
});

test("two tabs share write coordination while different Vaults stay isolated", async ({ page, context }) => {
  const otherPage = await context.newPage();
  await otherPage.goto("/");
  const race = async (value: number) => {
    const url = "/src/lib/vault/index.ts";
    const { openOpfsVault, vaultPath, VaultError } = await import(url) as VaultModule;
    const backend = await openOpfsVault();
    const results: string[] = [];
    for (let i = 0; i < 12; i++) {
      try {
        await backend.writeFile(vaultPath(`race-${i}`), new Uint8Array([value]), { mode: "create" });
        results.push("created");
      } catch (error) {
        results.push(error instanceof VaultError ? error.code : "unmapped error");
      }
    }
    await backend.close();
    return results;
  };
  const [first, second] = await Promise.all([page.evaluate(race, 1), otherPage.evaluate(race, 2)]);
  for (let i = 0; i < first.length; i++) {
    expect([first[i], second[i]].sort()).toEqual(["AlreadyExists", "created"]);
  }
  const result = await page.evaluate(async () => {
    const url = "/src/lib/vault/index.ts";
    const { openOpfsVault, vaultPath } = await import(url) as VaultModule;
    const backend = await openOpfsVault("other");
    const absent = await backend.stat(vaultPath("race-0"));
    await backend.writeFile(vaultPath("race-0"), new Uint8Array([3]), { mode: "create" });
    await backend.close();
    return absent;
  });
  expect(result).toBeNull();
});

test("close drains accepted writes, preserves their input snapshot and rejects later operations", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const url = "/src/lib/vault/index.ts";
    const { openOpfsVault, vaultPath, ROOT_PATH, VaultError } = await import(url) as VaultModule;
    const backend = await openOpfsVault();
    let release!: () => void;
    let acquired!: () => void;
    const ready = new Promise<void>((resolve) => { acquired = resolve; });
    const held = navigator.locks.request("celestite.vault.opfs:default", async () => {
      acquired();
      await new Promise<void>((resolve) => { release = resolve; });
    });
    await ready;
    const bytes = new Uint8Array([1, 2]);
    const write = backend.writeFile(vaultPath("queued"), bytes, { mode: "create" });
    bytes[0] = 99;
    let closed = false;
    const closing = backend.close().then(() => { closed = true; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const closedBeforeWrite = closed;
    release();
    await Promise.all([held, write, closing, backend.close()]);
    const errors: string[] = [];
    for (const operation of [
      () => backend.stat(ROOT_PATH),
      () => backend.readFile(vaultPath("queued")),
      () => backend.writeFile(vaultPath("late"), bytes, { mode: "create" }),
      () => backend.mkdir(vaultPath("late")),
      () => backend.remove(vaultPath("queued")),
      () => backend.rename(vaultPath("queued"), vaultPath("renamed")),
      () => backend.watch(() => {}),
      () => backend.readDir(ROOT_PATH)[Symbol.asyncIterator]().next(),
    ]) {
      try { await operation(); errors.push("unexpected success"); }
      catch (error) { errors.push(error instanceof VaultError ? error.code : "unmapped error"); }
    }
    const reopened = await openOpfsVault();
    const saved = Array.from(await reopened.readFile(vaultPath("queued")));
    const late = await reopened.stat(vaultPath("late"));
    const iterator = reopened.readDir(ROOT_PATH)[Symbol.asyncIterator]();
    await iterator.next();
    await reopened.close();
    let iteratorError;
    try { await iterator.next(); }
    catch (error) { iteratorError = error instanceof VaultError ? error.code : "unmapped error"; }
    return { closedBeforeWrite, saved, late, errors, iteratorError };
  });
  expect(result).toEqual({
    closedBeforeWrite: false, saved: [1, 2], late: null,
    errors: Array<string>(8).fill("Closed"), iteratorError: "Closed",
  });
});

test("rename streams files and directory trees, preserves empty directories and survives reload", async ({ page }) => {
  const beforeReload = await page.evaluate(async () => {
    const url = "/src/lib/vault/index.ts";
    const { openOpfsVault, vaultPath } = await import(url) as VaultModule;
    const backend = await openOpfsVault();
    await backend.mkdir(vaultPath("notes/nested/empty"), { recursive: true });
    await backend.mkdir(vaultPath("destination"));
    await backend.writeFile(vaultPath("notes/nested/中文.md"), new Uint8Array([0, 255, 128]), { mode: "create" });
    await backend.writeFile(vaultPath("notes/empty.md"), new Uint8Array(), { mode: "create" });
    const attachment = new Uint8Array(2 * 1024 * 1024 + 7).fill(137);
    await backend.writeFile(vaultPath("notes/attachment"), attachment, { mode: "create" });
    let events = 0;
    await backend.watch(() => { events++; });
    // 确认 rename 没有通过 arrayBuffer 全量读取正文或附件。
    const arrayBuffer = Blob.prototype.arrayBuffer;
    Blob.prototype.arrayBuffer = async () => { throw new Error("Whole-file read during rename"); };
    try {
      await backend.rename(vaultPath("notes/nested/中文.md"), vaultPath("destination/改名.md"));
      await backend.rename(vaultPath("notes"), vaultPath("notebook"));
    } finally { Blob.prototype.arrayBuffer = arrayBuffer; }
    const result = { source: await backend.stat(vaultPath("notes")), events };
    await backend.close();
    return result;
  });
  expect(beforeReload).toEqual({ source: null, events: 0 });
  await page.reload();
  const result = await page.evaluate(async () => {
    const url = "/src/lib/vault/index.ts";
    const { openOpfsVault, vaultPath } = await import(url) as VaultModule;
    const backend = await openOpfsVault();
    const attachment = await backend.readFile(vaultPath("notebook/attachment"));
    const result = {
      bytes: Array.from(await backend.readFile(vaultPath("destination/改名.md"))),
      directory: (await backend.stat(vaultPath("notebook/nested/empty")))?.kind,
      empty: (await backend.readFile(vaultPath("notebook/empty.md"))).byteLength,
      attachmentSize: attachment.byteLength,
      attachmentIntact: attachment.every((byte) => byte === 137),
    };
    await backend.close();
    return result;
  });
  expect(result).toEqual({ bytes: [0, 255, 128], directory: "directory", empty: 0, attachmentSize: 2 * 1024 * 1024 + 7, attachmentIntact: true });
});

test("rename protects root and descendants, rejects target conflicts and requires an existing source", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const url = "/src/lib/vault/index.ts";
    const { openOpfsVault, vaultPath, VaultError } = await import(url) as VaultModule;
    const backend = await openOpfsVault();
    await backend.mkdir(vaultPath("a/sub"), { recursive: true });
    await backend.mkdir(vaultPath("occupied"));
    await backend.writeFile(vaultPath("a/source"), new Uint8Array([1]), { mode: "create" });
    await backend.writeFile(vaultPath("target"), new Uint8Array([9]), { mode: "create" });
    const errors: string[] = [];
    for (const [from, to] of [
      ["", "new"], ["a", ""], ["a", "a/sub/new"], ["missing", "missing"],
      ["a/source", "target"], ["a", "occupied"], ["a/source", "occupied"], ["a", "target"],
      ["a/source", "missing/new"], ["a/source", "target/new"],
    ]) {
      try { await backend.rename(vaultPath(from), vaultPath(to)); errors.push("unexpected success"); }
      catch (error) { errors.push(error instanceof VaultError ? error.code : "unmapped error"); }
    }
    await backend.rename(vaultPath("a/source"), vaultPath("a/source"));
    await backend.rename(vaultPath("a"), vaultPath("a"));
    await backend.rename(vaultPath("a"), vaultPath("ab"));
    const result = {
      errors,
      source: Array.from(await backend.readFile(vaultPath("ab/source"))),
      target: Array.from(await backend.readFile(vaultPath("target"))),
      emptyDirectory: (await backend.stat(vaultPath("ab/sub")))?.kind,
    };
    await backend.close();
    return result;
  });
  expect(result).toEqual({
    errors: ["InvalidPath", "InvalidPath", "InvalidPath", "NotFound", "AlreadyExists", "AlreadyExists", "AlreadyExists", "AlreadyExists", "NotFound", "NotDirectory"],
    source: [1], target: [9], emptyDirectory: "directory",
  });
});

test("rename aborts failed child copies and reports source deletion failures without removing the target", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const url = "/src/lib/vault/index.ts";
    const { openOpfsVault, vaultPath, VaultRenameError } = await import(url) as VaultModule;
    const backend = await openOpfsVault();
    await backend.mkdir(vaultPath("source"));
    await backend.writeFile(vaultPath("source/a"), new Uint8Array([1]), { mode: "create" });
    await backend.writeFile(vaultPath("source/b"), new Uint8Array([2]), { mode: "create" });
    const errors: unknown[] = [];
    const attempt = async () => {
      try { await backend.rename(vaultPath("source"), vaultPath("target")); errors.push("unexpected success"); }
      catch (error) {
        errors.push(error instanceof VaultRenameError
          ? { code: error.code, phase: error.phase, targetComplete: error.targetComplete, cleanupFailed: !!error.cleanupError }
          : "unmapped error");
      }
    };
    const createWritable = FileSystemFileHandle.prototype.createWritable;
    FileSystemFileHandle.prototype.createWritable = async function (options) {
      const writable = await createWritable.call(this, options);
      if (this.name === "b") {
        const write = writable.write.bind(writable);
        writable.write = async (data) => {
          await write(data);
          throw new DOMException("Injected child failure", "QuotaExceededError");
        };
      }
      return writable;
    };
    try { await attempt(); }
    finally { FileSystemFileHandle.prototype.createWritable = createWritable; }
    const targetAfterCopyFailure = await backend.stat(vaultPath("target"));
    const sourceAfterCopyFailure = [
      Array.from(await backend.readFile(vaultPath("source/a"))),
      Array.from(await backend.readFile(vaultPath("source/b"))),
    ];
    const removeEntry = FileSystemDirectoryHandle.prototype.removeEntry;
    FileSystemDirectoryHandle.prototype.removeEntry = async function (name, options) {
      if (name === "source") {
        throw new DOMException("Injected source removal failure", "NoModificationAllowedError");
      }
      return removeEntry.call(this, name, options);
    };
    try { await attempt(); }
    finally { FileSystemDirectoryHandle.prototype.removeEntry = removeEntry; }
    const targetAfterRemoveFailure = [
      Array.from(await backend.readFile(vaultPath("target/a"))),
      Array.from(await backend.readFile(vaultPath("target/b"))),
    ];
    const sourceAfterRemoveFailure = (await backend.stat(vaultPath("source")))?.kind;
    await backend.close();
    return { errors, targetAfterCopyFailure, sourceAfterCopyFailure, targetAfterRemoveFailure, sourceAfterRemoveFailure };
  });
  expect(result).toEqual({
    errors: [
      { code: "QuotaExceeded", phase: "copy", targetComplete: false, cleanupFailed: false },
      { code: "Busy", phase: "remove-source", targetComplete: true, cleanupFailed: false },
    ],
    targetAfterCopyFailure: null, sourceAfterCopyFailure: [[1], [2]],
    targetAfterRemoveFailure: [[1], [2]], sourceAfterRemoveFailure: "directory",
  });
});

test("a failed staged write preserves old content and cleans a newly created entry", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const url = "/src/lib/vault/index.ts";
    const { openOpfsVault, vaultPath, VaultError } = await import(url) as VaultModule;
    const backend = await openOpfsVault();
    await backend.writeFile(vaultPath("existing"), new Uint8Array([1, 2]), { mode: "create" });
    const original = FileSystemFileHandle.prototype.createWritable;
    const errors: string[] = [];
    // 使用真实 OPFS 流，在暂存写入之后注入故障，验证 abort/清理行为。
    FileSystemFileHandle.prototype.createWritable = async function (options) {
      const writable = await original.call(this, options);
      const write = writable.write.bind(writable);
      writable.write = async (data) => {
        await write(data);
        throw new DOMException("Injected storage failure", "QuotaExceededError");
      };
      return writable;
    };
    try {
      for (const [path, mode] of [["existing", "replace"], ["new", "create"]] as const) {
        try { await backend.writeFile(vaultPath(path), new Uint8Array([9]), { mode }); }
        catch (error) { errors.push(error instanceof VaultError ? error.code : "unmapped error"); }
      }
    } finally {
      FileSystemFileHandle.prototype.createWritable = original;
    }
    const existing = Array.from(await backend.readFile(vaultPath("existing")));
    const absent = await backend.stat(vaultPath("new"));
    await backend.close();
    return { errors, existing, absent };
  });
  expect(result).toEqual({ errors: ["QuotaExceeded", "QuotaExceeded"], existing: [1, 2], absent: null });
});
