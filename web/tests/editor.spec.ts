import { installWorkerHarness, workerEvaluate } from "./worker-harness";
import { expect, test as base } from "@playwright/test";
type VaultModule = typeof import("../src/lib/vault");
const test = base.extend<{ runtimeErrors: string[] }>({
  runtimeErrors: [
    async ({ page }, use) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await use(errors);
      expect(errors).toEqual([]);
    },
    { auto: true },
  ],
});
test.beforeEach(async ({ page }) => {
  await installWorkerHarness(page);
  await page.goto("/");
  await page.evaluate(async () => {
    const url = "/src/lib/vault/index.ts";
    const { openOpfsVault, vaultPath } = (await import(url)) as VaultModule;
    const vault = await openOpfsVault();
    await vault.mkdir(vaultPath("notes"));
    for (const [path, content] of [
      ["a.md", "# Hello\n"],
      ["notes/b.ts", "const value = 1;\n"],
    ])
      await vault.writeFile(
        vaultPath(path),
        new TextEncoder().encode(content),
        { mode: "create" },
      );
    await vault.writeFile(
      vaultPath("binary.bin"),
      new Uint8Array([0, 255, 0]),
      { mode: "create" },
    );
    await vault.close();
  });
  await page.goto("/");
  await expect(
    page.getByRole("treeitem", { name: "a.md", exact: true }),
  ).toBeVisible();
});

async function openTestTabs(page: import("@playwright/test").Page) {
  await page.getByRole("treeitem", { name: "a.md", exact: true }).click();
  await page.getByRole("button", { name: "展开 notes", exact: true }).click();
  await page.getByRole("treeitem", { name: "b.ts", exact: true }).click();
  await page.getByRole("treeitem", { name: "binary.bin", exact: true }).click();
  await expect(page.getByRole("tab")).toHaveCount(3);
}

for (const { action, remaining } of [
  { action: "关闭标签页", remaining: ["a.md", "binary.bin"] },
  { action: "关闭其他标签页", remaining: ["notes/b.ts"] },
  { action: "关闭左侧标签页", remaining: ["notes/b.ts", "binary.bin"] },
  { action: "关闭右侧标签页", remaining: ["a.md", "notes/b.ts"] },
  { action: "关闭全部标签页", remaining: [] },
]) {
  test(`tab context menu ${action} uses the clicked tab and preserves order`, async ({
    page,
  }) => {
    await openTestTabs(page);
    await page
      .getByRole("tab", { name: "notes/b.ts", exact: true })
      .click({ button: "right" });
    await expect(
      page.getByRole("tab", {
        name: "binary.bin",
        exact: true,
        includeHidden: true,
      }),
    ).toHaveAttribute("aria-selected", "true");
    await page.getByRole("menuitem", { name: action, exact: true }).click();
    const tabs = page.getByRole("tab", { includeHidden: true });
    await expect(tabs).toHaveCount(remaining.length);
    expect(
      await tabs.evaluateAll((elements) =>
        elements.map((tab) => tab.getAttribute("aria-label")),
      ),
    ).toEqual(remaining);
    if (remaining.length) {
      await expect(
        page.locator('[role="tab"][aria-selected="true"]'),
      ).toHaveCount(1);
    } else {
      await expect(
        page.getByRole("heading", { name: "打开一份文件" }),
      ).toBeVisible();
    }
  });
}

test("tab context menu disables empty groups and Escape restores tab focus", async ({
  page,
}) => {
  await page.getByRole("treeitem", { name: "a.md", exact: true }).click();
  const tab = page.getByRole("tab", { name: "a.md", exact: true });
  await tab.click({ button: "right" });
  for (const action of ["关闭其他标签页", "关闭左侧标签页", "关闭右侧标签页"]) {
    await expect(
      page.getByRole("menuitem", { name: action, exact: true }),
    ).toBeDisabled();
  }
  await expect(
    page.getByRole("menuitem", { name: "关闭标签页", exact: true }),
  ).toBeEnabled();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toBeHidden();
  await expect(tab).toBeFocused();
});

test("middle-click closes an inactive tab without changing the active file", async ({
  page,
}) => {
  await openTestTabs(page);
  await page
    .getByRole("tab", { name: "notes/b.ts", exact: true })
    .click({ button: "middle" });
  await expect(page.getByRole("tab")).toHaveCount(2);
  await expect(
    page.getByRole("tab", { name: "binary.bin", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("menu")).toHaveCount(0);
});

test("closing other tabs saves an edited file before removing it", async ({
  page,
}) => {
  await openTestTabs(page);
  await page.getByRole("tab", { name: "notes/b.ts", exact: true }).click();
  await page
    .getByRole("textbox", { name: "代码编辑器" })
    .fill("const savedOnClose = true;");
  await page
    .getByRole("tab", { name: "a.md", exact: true })
    .click({ button: "right" });
  await page
    .getByRole("menuitem", { name: "关闭其他标签页", exact: true })
    .click();
  await expect(page.getByRole("tab")).toHaveCount(1);
  await expect(
    page.getByRole("tab", { name: "a.md", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  const content = await page.evaluate(async () => {
    const { openOpfsVault, vaultPath } = (await import(
      "/src/lib/vault/index.ts" as string
    )) as VaultModule;
    const vault = await openOpfsVault();
    const bytes = await vault.readFile(vaultPath("notes/b.ts"));
    await vault.close();
    return new TextDecoder().decode(bytes);
  });
  expect(content).toBe("const savedOnClose = true;");
});

test("batch closing stops at a conflict and cancellation keeps the draft and later tabs", async ({
  page,
}) => {
  await openTestTabs(page);
  await page.getByRole("tab", { name: "a.md", exact: true }).click();
  const editor = page.getByRole("textbox", { name: "代码编辑器" });
  await expect(editor).toBeVisible();
  await page.evaluate(async () => {
    const { openOpfsVault, vaultPath } = (await import(
      "/src/lib/vault/index.ts" as string
    )) as VaultModule;
    const vault = await openOpfsVault();
    await vault.writeFile(
      vaultPath("a.md"),
      new TextEncoder().encode("external change"),
      { mode: "replace" },
    );
    await vault.close();
  });
  await editor.fill("keep this local draft");
  await page
    .getByRole("tab", { name: "binary.bin", exact: true })
    .click({ button: "right" });
  await page
    .getByRole("menuitem", { name: "关闭全部标签页", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toContainText("文件已在磁盘上修改");
  await expect(
    page.getByRole("button", { name: "取消", exact: true }),
  ).toBeFocused();
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(page.getByRole("tab")).toHaveCount(3);
  await expect(editor).toContainText("keep this local draft");
});

test("opening a file shows a spinner in the editor area instead of a banner above the tabs", async ({
  page,
}) => {
  // 放慢正文读取，让加载态可被观察；只影响本用例的页面。
  await workerEvaluate(page, () => {
    const original = FileSystemFileHandle.prototype.getFile;
    FileSystemFileHandle.prototype.getFile = async function (
      this: FileSystemFileHandle,
    ) {
      if (this.name === "a.md") await new Promise((r) => setTimeout(r, 1200));
      return original.call(this);
    };
  });
  await page.getByRole("treeitem", { name: "a.md", exact: true }).click();
  const loading = page.locator(".editor-loading");
  await expect(loading).toBeVisible();
  await expect(loading).toContainText("正在打开 a.md…");
  await expect(loading.locator("svg.lucide-loader-circle")).toBeVisible();
  // 提示不在标签栏上方，而是编辑器区域内。
  await expect(page.getByRole("tablist", { name: "打开的文件" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "代码编辑器" })).toBeVisible({
    timeout: 10000,
  });
  await expect(loading).toHaveCount(0);
});

test("editing and Ctrl+S persist UTF-8 content to OPFS and survive reload", async ({
  page,
}) => {
  await page.getByRole("treeitem", { name: "a.md", exact: true }).click();
  const pane = page.getByRole("region", { name: "文件编辑器" });
  const editor = pane.getByRole("textbox", { name: "代码编辑器" });
  await expect(editor).toContainText("Hello");
  // Use CodeMirror's select-all command; locator.fill only selects DOM text,
  // which asynchronous language configuration can replace with the view selection.
  await editor.focus();
  await page.keyboard.press("Control+a");
  await page.keyboard.insertText("# 修改后的笔记\n\n真正保存的内容");
  await expect(page.getByRole("status", { name: "保存状态" })).toHaveText(
    "未保存",
  );
  await page.keyboard.press("Control+s");
  await expect(page.getByRole("status", { name: "保存状态" })).toHaveText(
    "已保存",
  );
  const content = await page.evaluate(async () => {
    const url = "/src/lib/vault/index.ts";
    const { openOpfsVault, vaultPath } = (await import(url)) as VaultModule;
    const vault = await openOpfsVault();
    const bytes = await vault.readFile(vaultPath("a.md"));
    await vault.close();
    return new TextDecoder().decode(bytes);
  });
  expect(content).toBe("# 修改后的笔记\n\n真正保存的内容");
  await page.reload();
  await page.getByRole("treeitem", { name: "a.md", exact: true }).click();
  await expect(editor).toContainText("真正保存的内容");
  await expect(page.locator(".cm-lineNumbers")).toBeVisible();
});

test("file switches and folder rename preserve undo history and future saves use the new path", async ({
  page,
}) => {
  await page.getByRole("button", { name: "展开 notes", exact: true }).click();
  await page.getByRole("treeitem", { name: "b.ts", exact: true }).click();
  const pane = page.getByRole("region", { name: "文件编辑器" });
  const editor = pane.getByRole("textbox", { name: "代码编辑器" });
  await editor.fill("const value = 2;");
  await expect(page.getByRole("status", { name: "保存状态" })).toHaveText(
    "未保存",
  );
  await page.keyboard.press("Control+s");
  await expect(page.getByRole("status", { name: "保存状态" })).toHaveText(
    "已保存",
  );
  await page.getByRole("treeitem", { name: "a.md", exact: true }).click();
  await page.getByRole("tab", { name: "notes/b.ts", exact: true }).click();
  await expect(editor).toContainText("const value = 2;");
  await editor.focus();
  await page.keyboard.press("Control+z");
  await expect(editor).toContainText("const value = 1;");
  await page
    .getByRole("treeitem", { name: "notes", exact: true })
    .locator(".tree-row")
    .first()
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: "重命名…" }).click();
  await page
    .getByRole("textbox", { name: "名称", exact: true })
    .fill("renamed");
  await page.getByRole("button", { name: "确认", exact: true }).click();
  await expect(
    page.getByRole("tab", { name: "renamed/b.ts", exact: true }),
  ).toBeVisible();
  await expect(editor).toContainText("const value = 1;");
  await editor.fill("const value = 3;");
  await page.keyboard.press("Control+s");
  await expect(page.getByRole("status", { name: "保存状态" })).toHaveText(
    "已保存",
  );
  const saved = await page.evaluate(async () => {
    const url = "/src/lib/vault/index.ts";
    const { openOpfsVault, vaultPath } = (await import(url)) as VaultModule;
    const vault = await openOpfsVault();
    const result = {
      old: await vault.stat(vaultPath("notes/b.ts")),
      content: new TextDecoder().decode(
        await vault.readFile(vaultPath("renamed/b.ts")),
      ),
    };
    await vault.close();
    return result;
  });
  expect(saved.old).toBeNull();
  expect(saved.content).toBe("const value = 3;");
});

test("write failure preserves edits, prevents closing, and retry commits the buffer", async ({
  page,
}) => {
  await page.getByRole("treeitem", { name: "a.md", exact: true }).click();
  const pane = page.getByRole("region", { name: "文件编辑器" });
  const editor = pane.getByRole("textbox", { name: "代码编辑器" });
  await expect(editor).toBeVisible();
  await workerEvaluate(page, () => {
    const original = FileSystemFileHandle.prototype.createWritable;
    (self as unknown as { writeFailures: number }).writeFailures = 0;
    (self as unknown as { restoreWriter: () => void }).restoreWriter = () => {
      FileSystemFileHandle.prototype.createWritable = original;
    };
    FileSystemFileHandle.prototype.createWritable = async function (options) {
      if (this.name === "a.md") {
        (self as unknown as { writeFailures: number }).writeFailures++;
        throw new DOMException("Injected quota failure", "QuotaExceededError");
      }
      return original.call(this, options);
    };
  });
  try {
    await editor.fill("this draft must survive");
    await expect(page.getByRole("status", { name: "保存状态" })).toHaveText(
      "未保存",
    );
    await page.keyboard.press("Control+s");
    await expect(pane.getByRole("alert")).toContainText("保存失败");
    await expect(editor).toContainText("this draft must survive");
    await page.getByRole("button", { name: "关闭 a.md", exact: true }).click();
    // Wait for the close attempt to encounter the injected error before restoring IO.
    await expect
      .poll(() =>
        workerEvaluate(
          page,
          () => (self as unknown as { writeFailures: number }).writeFailures,
        ),
      )
      .toBeGreaterThan(1);
    await expect(page.getByRole("status", { name: "保存状态" })).toHaveText(
      "保存失败",
    );
    await expect(
      page.getByRole("tab", { name: "a.md", exact: true }),
    ).toBeVisible();
    await workerEvaluate(page, () =>
      (self as unknown as { restoreWriter: () => void }).restoreWriter(),
    );
    await pane.getByRole("button", { name: "重试保存", exact: true }).click();
    await expect(page.getByRole("status", { name: "保存状态" })).toHaveText(
      "已保存",
    );
    await expect(pane.getByRole("alert")).toBeHidden();
    await page.reload();
    await page.getByRole("treeitem", { name: "a.md", exact: true }).click();
    await expect(editor).toContainText("this draft must survive");
  } finally {
    await workerEvaluate(page, () =>
      (self as unknown as { restoreWriter?: () => void }).restoreWriter?.(),
    );
  }
});

test("autosave, search, theme and word wrap work in the editor", async ({
  page,
}) => {
  await page.getByRole("treeitem", { name: "a.md", exact: true }).click();
  const pane = page.getByRole("region", { name: "文件编辑器" });
  const editor = pane.getByRole("textbox", { name: "代码编辑器" });
  await editor.fill("automatic save works");
  await expect(page.getByRole("status", { name: "保存状态" })).toHaveText(
    "未保存",
  );
  await expect(page.getByRole("status", { name: "保存状态" })).toHaveText(
    "已保存",
  );
  await editor.focus();
  await page.keyboard.press("Control+f");
  await expect(
    pane.getByRole("textbox", { name: "查找", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await pane.getByRole("button", { name: "自动换行", exact: true }).click();
  await expect(page.locator(".cm-content")).toHaveClass(/cm-lineWrapping/);
  await page.getByRole("button", { name: "主题", exact: true }).click();
  await page.getByRole("menuitem", { name: "深色", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  const surface = await pane.evaluate(
    (element) => getComputedStyle(element).backgroundColor,
  );
  await expect(page.locator(".cm-editor")).toHaveCSS(
    "background-color",
    surface,
  );
});

test("binary files cannot be edited, and mobile can return to the tree and reopen the same buffer", async ({
  page,
}) => {
  await page.getByRole("treeitem", { name: "binary.bin", exact: true }).click();
  const pane = page.getByRole("region", { name: "文件编辑器" });
  await expect(pane).toContainText("不是 UTF-8 文本");
  await expect(pane.getByRole("textbox", { name: "代码编辑器" })).toBeHidden();
  await expect(
    pane.getByRole("button", { name: "保存", exact: true }),
  ).toBeDisabled();
  await page.setViewportSize({ width: 360, height: 720 });
  await pane.getByRole("button", { name: "返回文件树", exact: true }).click();
  await page.getByRole("treeitem", { name: "a.md", exact: true }).click();
  const editor = pane.getByRole("textbox", { name: "代码编辑器" });
  await editor.fill("mobile draft");
  await expect(page.getByRole("status", { name: "保存状态" })).toHaveText(
    "未保存",
  );
  await pane.getByRole("button", { name: "返回文件树", exact: true }).click();
  await expect(pane).toBeHidden();
  await page.getByRole("treeitem", { name: "a.md", exact: true }).click();
  await expect(editor).toBeVisible();
  await expect(editor).toContainText("mobile draft");
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(360);
  await page.keyboard.press("Control+s");
  await expect(page.getByRole("status", { name: "保存状态" })).toHaveText(
    "已保存",
  );
});

test("committed private history restores a draft after public-file IO fails, with stable identity and a fresh writer", async ({
  page,
}) => {
  await page.getByRole("treeitem", { name: "a.md", exact: true }).click();
  const editor = page.getByRole("textbox", { name: "代码编辑器" });
  await expect(editor).toBeVisible();
  const before = await page.evaluate(() => {
    const messages = (window as unknown as { editorMessages: any[] })
      .editorMessages;
    return messages.find(
      (message) => message.kind === "reply" && message.result?.core,
    )?.result;
  });
  await workerEvaluate(page, () => {
    const original = FileSystemFileHandle.prototype.createWritable;
    FileSystemFileHandle.prototype.createWritable = async function (options) {
      if (this.name === "a.md")
        throw new DOMException("disk blocked", "QuotaExceededError");
      return original.call(this, options);
    };
  });
  await editor.fill("durable draft 😀 中文");
  await page.keyboard.press("Control+s");
  await expect(page.getByRole("status", { name: "保存状态" })).toHaveText(
    "保存失败",
  );
  // Simulates loss of the Worker rather than relying on pagehide async flushing.
  await page.evaluate(() =>
    (
      window as unknown as { editorWorkers: Worker[] }
    ).editorWorkers[0].terminate(),
  );
  await page.reload();
  await page.getByRole("treeitem", { name: "a.md", exact: true }).click();
  await expect(editor).toContainText("durable draft 😀 中文");
  const after = await page.evaluate(() => {
    const messages = (window as unknown as { editorMessages: any[] })
      .editorMessages;
    return messages.find(
      (message) => message.kind === "reply" && message.result?.core,
    )?.result;
  });
  expect(after.id).toBe(before.id);
  expect(after.core.version.identity).toEqual(before.core.version.identity);
  expect(after.core.writerId).not.toBe(before.core.writerId);
  expect(after.core.undo.can_undo).toBe(false); // Local undo is session-local.
  await page.keyboard.press("Control+s");
  await expect(page.getByRole("status", { name: "保存状态" })).toHaveText(
    "已保存",
  );
});

test("private history failure keeps the draft, pauses editing, and retries before writing the file", async ({
  page,
}) => {
  await page.getByRole("treeitem", { name: "a.md", exact: true }).click();
  const editor = page.getByRole("textbox", { name: "代码编辑器" });
  await expect(editor).toBeVisible();
  await workerEvaluate(page, () => {
    const original = FileSystemFileHandle.prototype.createWritable;
    (self as unknown as { restoreWriter: () => void }).restoreWriter = () => {
      FileSystemFileHandle.prototype.createWritable = original;
    };
    FileSystemFileHandle.prototype.createWritable = async function (options) {
      if (this.name === "head.json")
        throw new DOMException("journal blocked", "QuotaExceededError");
      return original.call(this, options);
    };
  });
  await editor.fill("history must commit first");
  await expect(
    page.getByRole("region", { name: "文件编辑器" }).getByRole("alert"),
  ).toContainText("编辑历史尚未持久化");
  await expect(editor).toHaveAttribute("contenteditable", "false");
  await expect(editor).toContainText("history must commit first");
  const disk = await page.evaluate(async () => {
    const { openOpfsVault, vaultPath } = (await import(
      "/src/lib/vault/index.ts" as string
    )) as VaultModule;
    return new TextDecoder().decode(
      await (await openOpfsVault()).readFile(vaultPath("a.md")),
    );
  });
  expect(disk).toBe("# Hello\n");
  await workerEvaluate(page, () =>
    (self as unknown as { restoreWriter: () => void }).restoreWriter(),
  );
  await page.getByRole("button", { name: "重试保存", exact: true }).click();
  await expect(page.getByRole("status", { name: "保存状态" })).toHaveText(
    "已保存",
  );
  await expect(editor).toHaveAttribute("contenteditable", "true");
  await page.reload();
  await page.getByRole("treeitem", { name: "a.md", exact: true }).click();
  await expect(editor).toContainText("history must commit first");
});

test("rapid input remains ordered while Worker history writes are slow; core undo and redo work", async ({
  page,
}) => {
  await page.getByRole("treeitem", { name: "a.md", exact: true }).click();
  const editor = page.getByRole("textbox", { name: "代码编辑器" });
  await editor.fill("");
  await page.keyboard.press("Control+s");
  await expect(page.getByRole("status", { name: "保存状态" })).toHaveText(
    "已保存",
  );
  await workerEvaluate(page, () => {
    const original = FileSystemFileHandle.prototype.createWritable;
    FileSystemFileHandle.prototype.createWritable = async function (options) {
      if (this.name === "head.json")
        await new Promise((resolve) => setTimeout(resolve, 40));
      return original.call(this, options);
    };
  });
  await editor.pressSequentially("abcdefghijklmnopqrstuvwxyz0123456789");
  await page.keyboard.press("Control+s");
  await expect(page.getByRole("status", { name: "保存状态" })).toHaveText(
    "已保存",
    { timeout: 10000 },
  );
  await expect(editor).toHaveText("abcdefghijklmnopqrstuvwxyz0123456789");
  await page.keyboard.press("Control+z");
  await expect(editor).toHaveText("");
  await page.keyboard.press("Control+Shift+Z");
  await expect(editor).toHaveText("abcdefghijklmnopqrstuvwxyz0123456789");
});

test("OPFS external modification shows the conflict dialog and discard adopts disk text", async ({
  page,
}) => {
  await page.getByRole("treeitem", { name: "a.md", exact: true }).click();
  const editor = page.getByRole("textbox", { name: "代码编辑器" });
  await expect(editor).toBeVisible();
  await page.evaluate(async () => {
    const { openOpfsVault, vaultPath } = (await import(
      "/src/lib/vault/index.ts" as string
    )) as VaultModule;
    await (
      await openOpfsVault()
    ).writeFile(vaultPath("a.md"), new TextEncoder().encode("outside editor"), {
      mode: "replace",
    });
  });
  await editor.fill("local draft");
  await page.keyboard.press("Control+s");
  await expect(page.getByRole("dialog")).toContainText("文件已在磁盘上修改");
  await page.getByRole("button", { name: "丢弃编辑", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(editor).toHaveText("outside editor");
  await editor.focus();
  await page.keyboard.press("Control+z");
  await expect(editor).toHaveText("outside editor");
  await page.reload();
  await page.getByRole("treeitem", { name: "a.md", exact: true }).click();
  await expect(editor).toHaveText("outside editor");
});

test("a second tab cannot own the same OPFS history journal", async ({
  page,
  context,
}) => {
  const other = await context.newPage();
  await other.goto("/");
  await expect(other.locator("p[role=alert]")).toContainText("另一标签页");
  await expect(other.getByRole("textbox", { name: "代码编辑器" })).toHaveCount(
    0,
  );
  await other.close();
  await page.getByRole("treeitem", { name: "a.md", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "代码编辑器" })).toContainText(
    "Hello",
  );
});

test("reopening a closed view adopts external disk changes without reseeding its history", async ({
  page,
}) => {
  await page.getByRole("treeitem", { name: "a.md", exact: true }).click();
  const editor = page.getByRole("textbox", { name: "代码编辑器" });
  await expect(editor).toContainText("Hello");
  const identity = await page.evaluate(
    () =>
      (window as unknown as { editorMessages: any[] }).editorMessages.find(
        (message) => message.kind === "reply" && message.result?.core,
      )?.result.core.version.identity,
  );
  await page.getByRole("button", { name: "关闭 a.md", exact: true }).click();
  await expect(
    page.getByRole("tab", { name: "a.md", exact: true }),
  ).toHaveCount(0);
  await page.evaluate(async () => {
    const { openOpfsVault, vaultPath } = (await import(
      "/src/lib/vault/index.ts" as string
    )) as VaultModule;
    await (
      await openOpfsVault()
    ).writeFile(
      vaultPath("a.md"),
      new TextEncoder().encode("external after closing view"),
      { mode: "replace" },
    );
  });
  await page.getByRole("treeitem", { name: "a.md", exact: true }).click();
  await expect(editor).toHaveText("external after closing view");
  const reopened = await page.evaluate(
    () =>
      (window as unknown as { editorMessages: any[] }).editorMessages
        .filter((message) => message.kind === "reply" && message.result?.core)
        .slice(-1)[0].result.core.version.identity,
  );
  expect(reopened).toEqual(identity);
  await page.keyboard.press("Control+z");
  await expect(editor).toHaveText("external after closing view");
});

test("legacy OPFS journals restore identity and unsaved text before upgrading on save", async ({
  page,
}) => {
  await page.getByRole("treeitem", { name: "a.md", exact: true }).click();
  const editor = page.getByRole("textbox", { name: "代码编辑器" });
  await expect(editor).toBeVisible();
  await workerEvaluate(page, () => {
    const original = FileSystemFileHandle.prototype.createWritable;
    FileSystemFileHandle.prototype.createWritable = async function (options) {
      if (this.name === "a.md")
        throw new DOMException("disk blocked", "QuotaExceededError");
      return original.call(this, options);
    };
  });
  await editor.fill("legacy draft 😀 中文");
  await page.keyboard.press("Control+s");
  await expect(page.getByRole("status", { name: "保存状态" })).toHaveText(
    "保存失败",
  );
  await page.evaluate(() =>
    (
      window as unknown as { editorWorkers: Worker[] }
    ).editorWorkers[0].terminate(),
  );
  const identity = await page.evaluate(async () => {
    const root = await (
      await (
        await navigator.storage.getDirectory()
      ).getDirectoryHandle("editor-instances")
    ).getDirectoryHandle("default");
    const catalog = JSON.parse(
      await (await (await root.getFileHandle("catalog.json")).getFile()).text(),
    );
    const entry = catalog.entries.find(
      (item: { path: string }) => item.path === "a.md",
    );
    const directory = await (
      await root.getDirectoryHandle("documents")
    ).getDirectoryHandle(entry.id);
    const head = JSON.parse(
      await (
        await (await directory.getFileHandle("head.json")).getFile()
      ).text(),
    );
    const header = head.header;
    const write = async (name: string, value: unknown) => {
      const stream = await (
        await directory.getFileHandle(name, { create: true })
      ).createWritable();
      await stream.write(JSON.stringify(value));
      await stream.close();
    };
    await write("projection.json", {
      savedContent: header.saved_text,
      diskRevision: header.disk_revision,
      bom: header.bom,
      lineEnding: header.line_ending,
    });
    await write("head.json", {
      sequence: head.sequence,
      version: head.version,
    });
    const updates = await directory.getDirectoryHandle("updates");
    for (let sequence = 1; sequence <= head.sequence; sequence++)
      await updates.removeEntry(`${sequence}.meta.json`);
    return { document_id: entry.id, history_id: entry.historyId };
  });
  await page.reload();
  await page.getByRole("treeitem", { name: "a.md", exact: true }).click();
  await expect(editor).toContainText("legacy draft 😀 中文");
  const restored = await page.evaluate(
    () =>
      (window as unknown as { editorMessages: any[] }).editorMessages.find(
        (message) => message.kind === "reply" && message.result?.core,
      )?.result,
  );
  expect(restored.core.version.identity).toEqual(identity);
  await editor.fill("upgraded draft 😀");
  await page.keyboard.press("Control+s");
  await expect(page.getByRole("status", { name: "保存状态" })).toHaveText(
    "已保存",
  );
  await page.reload();
  await page.getByRole("treeitem", { name: "a.md", exact: true }).click();
  await expect(editor).toContainText("upgraded draft 😀");
});
