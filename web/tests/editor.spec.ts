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

test("opening a file shows a spinner in the editor area instead of a banner above the tabs", async ({
  page,
}) => {
  // 放慢正文读取，让加载态可被观察；只影响本用例的页面。
  await page.evaluate(() => {
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
  await editor.fill("# 修改后的笔记\n\n真正保存的内容");
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
  await page.evaluate(() => {
    const original = FileSystemFileHandle.prototype.createWritable;
    (window as unknown as { writeFailures: number }).writeFailures = 0;
    (window as unknown as { restoreWriter: () => void }).restoreWriter = () => {
      FileSystemFileHandle.prototype.createWritable = original;
    };
    FileSystemFileHandle.prototype.createWritable = async function (options) {
      if (this.name === "a.md") {
        (window as unknown as { writeFailures: number }).writeFailures++;
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
        page.evaluate(
          () => (window as unknown as { writeFailures: number }).writeFailures,
        ),
      )
      .toBeGreaterThan(1);
    await expect(page.getByRole("status", { name: "保存状态" })).toHaveText(
      "保存失败",
    );
    await expect(
      page.getByRole("tab", { name: "a.md", exact: true }),
    ).toBeVisible();
    await page.evaluate(() =>
      (window as unknown as { restoreWriter: () => void }).restoreWriter(),
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
    await page.evaluate(() =>
      (window as unknown as { restoreWriter?: () => void }).restoreWriter?.(),
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
