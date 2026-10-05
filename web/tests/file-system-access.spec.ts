import { expect, test, type Page } from "@playwright/test";
import { installWorkerHarness, workerEvaluate } from "./worker-harness";

// Only the native chooser is replaced. Handles, structured cloning, IndexedDB,
// streams, Web Locks and the Worker/WASM editor are real browser implementations.
async function installPicker(page: Page, source = "one\ntwo\n") {
  await installWorkerHarness(page);
  await page.addInitScript(() => {
    Object.assign(window, {
      showDirectoryPicker: async (options: { mode: string }) => {
        if (!navigator.userActivation.isActive || options.mode !== "readwrite")
          throw new Error(
            "Chooser must request readwrite during user activation",
          );
        const root = await navigator.storage.getDirectory();
        return root.getDirectoryHandle("Test Project", { create: true });
      },
    });
  });
  await page.goto("/");
  await page.evaluate(async (source) => {
    const root = await (
      await navigator.storage.getDirectory()
    ).getDirectoryHandle("Test Project", { create: true });
    const stream = await (
      await root.getFileHandle("a.md", { create: true })
    ).createWritable();
    await stream.write(source);
    await stream.close();
  }, source);
  await page.getByRole("button", { name: "管理 Vault", exact: true }).click();
  await page.getByRole("button", { name: "打开本机目录", exact: true }).click();
  await expect(
    page.getByRole("treeitem", { name: "a.md", exact: true }),
  ).toBeVisible();
}
async function changeDisk(page: Page, text: string) {
  await page.evaluate(async (text) => {
    const root = await (
      await navigator.storage.getDirectory()
    ).getDirectoryHandle("Test Project");
    const stream = await (await root.getFileHandle("a.md")).createWritable();
    await stream.write(text);
    await stream.close();
    window.dispatchEvent(new Event("focus"));
  }, text);
}
async function diskText(page: Page) {
  return page.evaluate(async () => {
    const root = await (
      await navigator.storage.getDirectory()
    ).getDirectoryHandle("Test Project");
    return (await (await root.getFileHandle("a.md")).getFile()).text();
  });
}
const editor = (page: Page) =>
  page.getByRole("textbox", { name: "代码编辑器" });

test("idle directory observations keep highlighting and tree controls stable while disk changes still arrive", async ({
  page,
}) => {
  await installPicker(page, "# Heading\n\n**strong** and #badge[label]\n");
  await page.getByRole("treeitem", { name: "a.md", exact: true }).click();
  await expect(
    editor(page).locator('[data-syntax="function.call"]'),
  ).toHaveText("badge");
  const stability = await page.evaluate(async () => {
    const content = document.querySelector(".cm-content")!;
    const token = content.querySelector('[data-syntax="function.call"]');
    let mutations = 0;
    const observer = new MutationObserver((records) => {
      mutations += records.length;
    });
    observer.observe(content, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    observer.observe(document.querySelector(".tree-toolbar")!, {
      attributes: true,
      subtree: true,
      attributeFilter: ["disabled"],
    });
    observer.observe(document.querySelector(".tree-body")!, {
      attributes: true,
      attributeFilter: ["aria-busy"],
    });
    window.dispatchEvent(new Event("focus"));
    await new Promise((resolve) => setTimeout(resolve, 6500));
    observer.disconnect();
    return {
      mutations,
      sameContent: content === document.querySelector(".cm-content"),
      sameToken:
        token === content.querySelector('[data-syntax="function.call"]'),
    };
  });
  expect(stability).toEqual({
    mutations: 0,
    sameContent: true,
    sameToken: true,
  });
  await changeDisk(page, "# Changed\n\n#newcall[value]\n");
  await expect(
    editor(page).locator('[data-syntax="function.call"]'),
  ).toHaveText("newcall");
  await page.evaluate(async () => {
    const root = await (
      await navigator.storage.getDirectory()
    ).getDirectoryHandle("Test Project");
    const stream = await (
      await root.getFileHandle("external.md", { create: true })
    ).createWritable();
    await stream.write("external\n");
    await stream.close();
    window.dispatchEvent(new Event("focus"));
  });
  await expect(
    page.getByRole("treeitem", { name: "external.md", exact: true }),
  ).toBeVisible();
});

test("composition defers observation and writeback until accepted input has settled", async ({
  page,
}) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const vaultUrl = "/src/lib/vault/index.ts";
    const clientUrl = "/src/lib/editor/client/documents.ts";
    const { openDirectoryVault, vaultPath } = await import(vaultUrl);
    const { openLocalEditor } = await import(clientUrl);
    const root = await (
      await navigator.storage.getDirectory()
    ).getDirectoryHandle("ime-test", { create: true });
    const backend = await openDirectoryVault(root, "ime-test");
    const path = vaultPath("a.md");
    await backend.writeFile(path, new TextEncoder().encode("base\n"), {
      mode: "create",
    });
    const runtime = await openLocalEditor({
      kind: "directory",
      id: `directory:${crypto.randomUUID()}`,
      handle: root,
    });
    const documents = runtime.documents;
    await documents.open(path);
    const id = documents.snapshot().activeId!;
    documents.composition(id, true);
    const selection = { mainIndex: 0, ranges: [{ anchor: 5, head: 5 }] };
    documents.edit(id, {
      content: "base\n本地",
      edits: [{ from: 5, to: 5, insert: "本地" }],
      before: selection,
      after: selection,
      userEvent: "input.type.compose",
    });
    await documents.observeFiles();
    await backend.writeFile(
      path,
      new TextEncoder().encode("external\nbase\n"),
      { mode: "replace" },
    );
    await documents.observeFiles();
    const during = documents.snapshot().documents[0].content;
    const savedDuring = await documents.save(id);
    const diskDuring = new TextDecoder().decode(await backend.readFile(path));
    documents.composition(id, false);
    await documents.observeFiles();
    const after = documents.snapshot().documents[0].content;
    await documents.close();
    await backend.close();
    return { during, savedDuring, diskDuring, after };
  });
  expect(result).toEqual({
    during: "base\n本地",
    savedDuring: false,
    diskDuring: "external\nbase\n",
    after: "external\nbase\n本地",
  });
});

test("a disk change during staged replacement rejects the save and preserves the external file", async ({
  page,
}) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const url = "/src/lib/vault/index.ts";
    const { openDirectoryVault, vaultPath } = await import(url);
    const root = await (
      await navigator.storage.getDirectory()
    ).getDirectoryHandle("race-test", { create: true });
    const backend = await openDirectoryVault(root, "race-test");
    const path = vaultPath("a.md");
    await backend.writeFile(path, new TextEncoder().encode("baseline"), {
      mode: "create",
    });
    const snapshot = await backend.readFileSnapshot!(path);
    const original = FileSystemFileHandle.prototype.createWritable;
    let raced = false;
    FileSystemFileHandle.prototype.createWritable = async function (options) {
      const stream = await original.call(this, options);
      const write = stream.write.bind(stream);
      stream.write = async (data) => {
        await write(data);
        if (!raced && this.name === "a.md") {
          raced = true;
          const external = await original.call(this);
          await external.write("external");
          await external.close();
        }
      };
      return stream;
    };
    let code: string | undefined;
    try {
      await backend.writeFile(path, new TextEncoder().encode("local"), {
        mode: "replace",
        expectedRevision: snapshot.revision,
      });
    } catch (error) {
      code = (error as { code: string }).code;
    } finally {
      FileSystemFileHandle.prototype.createWritable = original;
    }
    const text = new TextDecoder().decode(await backend.readFile(path));
    await backend.close();
    return { code, text };
  });
  expect(result).toEqual({ code: "Conflict", text: "external" });
});

test("an externally changed move source is retained alongside the complete target", async ({
  page,
}) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const url = "/src/lib/vault/index.ts";
    const { openDirectoryVault, vaultPath } = await import(url);
    const root = await (
      await navigator.storage.getDirectory()
    ).getDirectoryHandle("move-race-test", { create: true });
    const backend = await openDirectoryVault(root, "move-race-test");
    await backend.writeFile(
      vaultPath("source"),
      new TextEncoder().encode("old"),
      { mode: "create" },
    );
    const original = FileSystemFileHandle.prototype.createWritable;
    FileSystemFileHandle.prototype.createWritable = async function (options) {
      const stream = await original.call(this, options);
      const close = stream.close.bind(stream);
      stream.close = async () => {
        await close();
        if (this.name === "target") {
          const source = await original.call(
            await root.getFileHandle("source"),
          );
          await source.write("external replacement");
          await source.close();
        }
      };
      return stream;
    };
    let failure: unknown;
    try {
      await backend.rename(vaultPath("source"), vaultPath("target"));
    } catch (error) {
      const e = error as {
        code: string;
        phase: string;
        targetComplete: boolean;
      };
      failure = {
        code: e.code,
        phase: e.phase,
        targetComplete: e.targetComplete,
      };
    } finally {
      FileSystemFileHandle.prototype.createWritable = original;
    }
    const source = new TextDecoder().decode(
      await backend.readFile(vaultPath("source")),
    );
    const target = new TextDecoder().decode(
      await backend.readFile(vaultPath("target")),
    );
    await backend.close();
    return { failure, source, target };
  });
  expect(result).toEqual({
    failure: { code: "Conflict", phase: "remove-source", targetComplete: true },
    source: "external replacement",
    target: "old",
  });
});

test("a picked directory edits in the core, persists its handle and keeps history out of the file tree", async ({
  page,
}) => {
  await installPicker(page);
  const id = await page
    .getByRole("combobox", { name: "当前 Vault" })
    .inputValue();
  expect(id).toMatch(/^directory:/);
  await page.getByRole("treeitem", { name: "a.md", exact: true }).click();
  await expect(editor(page)).toContainText("one");
  await editor(page).focus();
  await page.keyboard.press("Control+End");
  await page.keyboard.insertText("local\n");
  await page.keyboard.press("Control+s");
  await expect(page.getByRole("status", { name: "保存状态" })).toHaveText(
    "已保存",
  );
  expect(await diskText(page)).toBe("one\ntwo\nlocal\n");
  await page.reload();
  await page.getByRole("combobox", { name: "当前 Vault" }).selectOption(id);
  await page.getByRole("treeitem", { name: "a.md", exact: true }).click();
  await expect(editor(page)).toContainText("local");
  const entries = await page.evaluate(async () => {
    const opfs = await navigator.storage.getDirectory();
    const directory = await opfs.getDirectoryHandle("Test Project");
    const entries = [];
    for await (const [name] of directory.entries()) entries.push(name);
    const histories = await opfs.getDirectoryHandle("editor-instances");
    const ids = [];
    for await (const [name] of histories.entries()) ids.push(name);
    return { entries, ids };
  });
  expect(entries.entries).toEqual(["a.md"]);
  expect(entries.ids).toContain(`directory-${id.slice("directory:".length)}`);
  await page.getByRole("button", { name: "管理 Vault", exact: true }).click();
  await page.getByRole("button", { name: "打开本机目录", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "当前 Vault" })).toHaveValue(
    id,
  );
  await expect(
    page.getByRole("combobox", { name: "当前 Vault" }).locator("option"),
  ).toHaveCount(2);
});

test("external saves merge with unsaved input, preserve personal undo and redo", async ({
  page,
}) => {
  await installPicker(page);
  await page.getByRole("treeitem", { name: "a.md", exact: true }).click();
  await editor(page).focus();
  await page.keyboard.press("Control+End");
  await page.keyboard.insertText("local\n");
  await changeDisk(page, "external\none\ntwo\n");
  await expect(editor(page)).toContainText("external");
  await expect(editor(page)).toContainText("local");
  expect(await diskText(page)).toBe("external\none\ntwo\n");
  await editor(page).focus();
  await page.keyboard.press("Control+z");
  await expect(editor(page)).not.toContainText("local");
  await expect(editor(page)).toContainText("external");
  await page.keyboard.press("Control+Shift+Z");
  await expect(editor(page)).toContainText("local");
  await page.keyboard.press("Control+s");
  await expect(page.getByRole("status", { name: "保存状态" })).toHaveText(
    "已保存",
  );
  expect(await diskText(page)).toBe("external\none\ntwo\nlocal\n");
});

test("saving observes external content even without a focus hint", async ({
  page,
}) => {
  await installPicker(page);
  await page.getByRole("treeitem", { name: "a.md", exact: true }).click();
  await editor(page).focus();
  await page.keyboard.press("Control+End");
  await page.keyboard.insertText("local\n");
  await page.evaluate(async () => {
    const root = await (
      await navigator.storage.getDirectory()
    ).getDirectoryHandle("Test Project");
    const stream = await (await root.getFileHandle("a.md")).createWritable();
    await stream.write("external\none\ntwo\n");
    await stream.close();
  });
  await page.keyboard.press("Control+s");
  await expect(page.getByRole("status", { name: "保存状态" })).toHaveText(
    "已保存",
  );
  await expect(editor(page)).toContainText("external");
  await expect(editor(page)).toContainText("local");
  expect(await diskText(page)).toBe("external\none\ntwo\nlocal\n");
});

test("a second tab cannot open a directory whose private history is already owned", async ({
  page,
  context,
}) => {
  await installPicker(page);
  const id = await page
    .getByRole("combobox", { name: "当前 Vault" })
    .inputValue();
  const other = await context.newPage();
  await other.goto("/");
  // Its default Vault may be busy; open the stored directory from the error view's management dialog.
  await other.getByRole("button", { name: "管理 Vault", exact: true }).click();
  await other
    .getByRole("dialog")
    .getByRole("button", { name: "打开", exact: true })
    .last()
    .click();
  await expect(other.getByRole("dialog").getByRole("alert")).toContainText(
    "另一标签页",
  );
  await page.close();
  await other
    .getByRole("dialog")
    .getByRole("button", { name: "打开", exact: true })
    .last()
    .click();
  await expect(other.getByRole("combobox", { name: "当前 Vault" })).toHaveValue(
    id,
  );
});

test("permission failure keeps the draft and permits saving after permission is restored", async ({
  page,
}) => {
  await installPicker(page);
  await page.getByRole("treeitem", { name: "a.md", exact: true }).click();
  await editor(page).focus();
  await page.keyboard.press("Control+End");
  await page.keyboard.insertText("local\n");
  await workerEvaluate(
    page,
    () => {
      const state = self as unknown as {
        originalGetFile?: typeof FileSystemFileHandle.prototype.getFile;
      };
      state.originalGetFile = FileSystemFileHandle.prototype.getFile;
      FileSystemFileHandle.prototype.getFile = async function () {
        if (this.name === "a.md")
          throw new DOMException("Permission revoked", "NotAllowedError");
        return state.originalGetFile!.call(this);
      };
    },
    undefined,
    1,
  );
  await page.keyboard.press("Control+s");
  await expect(page.getByRole("status", { name: "保存状态" })).toHaveText(
    "保存失败",
  );
  await expect(editor(page)).toContainText("local");
  expect(await diskText(page)).toBe("one\ntwo\n");
  await workerEvaluate(
    page,
    () => {
      const state = self as unknown as {
        originalGetFile: typeof FileSystemFileHandle.prototype.getFile;
      };
      FileSystemFileHandle.prototype.getFile = state.originalGetFile;
    },
    undefined,
    1,
  );
  await page.keyboard.press("Control+s");
  await expect(page.getByRole("status", { name: "保存状态" })).toHaveText(
    "已保存",
  );
  expect(await diskText(page)).toBe("one\ntwo\nlocal\n");
});

test("directory registry deduplicates the same handle across tabs and distinguishes equal names", async ({
  page,
  context,
}) => {
  await page.goto("/");
  const register = async () => {
    const url = "/src/lib/vault/directory-registry.ts";
    const { IndexedDbDirectoryRegistry } = await import(url);
    const opfs = await navigator.storage.getDirectory();
    const root = await opfs.getDirectoryHandle("registry-test", {
      create: true,
    });
    const handle = await root.getDirectoryHandle("Project", { create: true });
    return (await new IndexedDbDirectoryRegistry().remember(handle)).id;
  };
  const other = await context.newPage();
  await other.goto("/");
  const ids = await Promise.all([
    page.evaluate(register),
    other.evaluate(register),
  ]);
  expect(ids[0]).toBe(ids[1]);
  const result = await page.evaluate(async () => {
    const url = "/src/lib/vault/directory-registry.ts";
    const { IndexedDbDirectoryRegistry } = await import(url);
    const opfs = await navigator.storage.getDirectory();
    const root = await opfs.getDirectoryHandle("another-root", {
      create: true,
    });
    const handle = await root.getDirectoryHandle("Project", { create: true });
    const registry = new IndexedDbDirectoryRegistry();
    const record = await registry.remember(handle);
    const entries = await registry.list();
    await registry.forget(record.id);
    return {
      id: record.id,
      names: entries.map((entry: { name: string }) => entry.name),
      remaining: (await registry.list()).length,
    };
  });
  expect(result.id).not.toBe(ids[0]);
  expect(result.names).toEqual(["Project", "Project"]);
  expect(result.remaining).toBe(1);
});
