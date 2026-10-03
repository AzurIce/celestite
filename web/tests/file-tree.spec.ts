import { expect, test as base, type Page } from "@playwright/test";
type VaultModule = typeof import("../src/lib/vault");

// 打开文件后编辑器也会提供 role="status"，这里只取文件树自己的状态行。
const treeStatus = (page: Page) =>
  page.getByRole("status", { name: "文件树状态" });

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
  await page.goto("/ui");
  await page.evaluate(async () => {
    const url = "/src/lib/vault/index.ts";
    const { openOpfsVault, vaultPath } = (await import(url)) as VaultModule;
    const backend = await openOpfsVault();
    await backend.mkdir(vaultPath("Archive"));
    await backend.mkdir(vaultPath("Inbox/Nested"), { recursive: true });
    for (const path of ["a.md", "b.md", "c.md", "Inbox/alpha.md"]) {
      await backend.writeFile(
        vaultPath(path),
        new TextEncoder().encode(`# ${path}`),
        { mode: "create" },
      );
    }
    await backend.close();
  });
  await page.goto("/");
  await expect(
    page.getByRole("treeitem", { name: "a.md", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("tree", { name: "文件树" })).toHaveAttribute(
    "aria-busy",
    "false",
  );
});

test("Ctrl/Shift selection and context menus preserve multi-selection and target unselected rows", async ({
  page,
}) => {
  const item = (name: string) =>
    page.getByRole("treeitem", { name, exact: true });
  await item("a.md").click();
  await item("c.md").click({ modifiers: ["Control"] });
  await expect(item("a.md")).toHaveAttribute("aria-selected", "true");
  await expect(item("a.md").locator(".tree-row")).toHaveAttribute(
    "data-selected",
    "true",
  );
  await expect(item("b.md")).toHaveAttribute("aria-selected", "false");
  await expect(item("c.md")).toHaveAttribute("aria-selected", "true");
  await item("a.md").click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "重命名…" })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  await expect(treeStatus(page)).toHaveText("已选择 2 项");
  await page.keyboard.press("Escape");
  await item("a.md").click();
  await item("c.md").click({ modifiers: ["Shift"] });
  await expect(item("b.md")).toHaveAttribute("aria-selected", "true");
  await expect(treeStatus(page)).toHaveText("已选择 3 项");
  await item("Inbox").locator(".tree-row").first().click({ button: "right" });
  await expect(treeStatus(page)).toHaveText("已选择 1 项");
  await expect(item("Inbox")).toHaveAttribute("aria-selected", "true");
  await expect(item("a.md")).toHaveAttribute("aria-selected", "false");
});

test("keyboard navigation expands lazily, supports focus-only movement and opens a keyboard context menu", async ({
  page,
}) => {
  const tree = page.getByRole("tree", { name: "文件树" });
  await tree.focus();
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowRight");
  await expect(
    page.getByRole("treeitem", { name: "alpha.md", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("treeitem", { name: "Inbox", exact: true }),
  ).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("ArrowLeft");
  await expect(
    page.getByRole("treeitem", { name: "alpha.md", exact: true }),
  ).toBeHidden();
  await page.keyboard.press("b");
  await expect(
    page.getByRole("treeitem", { name: "b.md", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Control+ArrowDown");
  await expect(
    page.getByRole("treeitem", { name: "c.md", exact: true }),
  ).toHaveAttribute("aria-selected", "false");
  await expect(tree).toHaveAttribute("aria-activedescendant", /c\.md$/);
  await page.keyboard.press("Shift+F10");
  await expect(page.getByRole("menuitem", { name: "重命名…" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(tree).toBeFocused();
});

test("create, F2 rename, invalid names and duplicate conflicts update real OPFS and survive reload", async ({
  page,
}) => {
  await page.getByRole("button", { name: "新建文件夹", exact: true }).click();
  await page.getByRole("textbox", { name: "名称", exact: true }).fill("Work");
  await page.getByRole("button", { name: "确认", exact: true }).click();
  await expect(
    page.getByRole("treeitem", { name: "Work", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "新建文件", exact: true }).click();
  await page
    .getByRole("textbox", { name: "名称", exact: true })
    .fill("draft.md");
  await page.getByRole("button", { name: "确认", exact: true }).click();
  const draft = page.getByRole("treeitem", { name: "draft.md", exact: true });
  await expect(draft).toBeVisible();
  await expect(draft.locator(".tree-row")).toHaveAttribute(
    "data-path",
    "Work/draft.md",
  );
  await draft.click();
  await page.keyboard.press("F2");
  await expect(
    page.getByRole("dialog", { name: "重命名", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("textbox", { name: "名称", exact: true })
    .fill("../outside");
  await page.getByRole("button", { name: "确认", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
    "名称无效",
  );
  await page
    .getByRole("textbox", { name: "名称", exact: true })
    .fill("done.md");
  await page.getByRole("button", { name: "确认", exact: true }).click();
  await expect(
    page.getByRole("treeitem", { name: "done.md", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("treeitem", { name: "a.md", exact: true })
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: "重命名…" }).click();
  await page.getByRole("textbox", { name: "名称", exact: true }).fill("b.md");
  await page.getByRole("button", { name: "确认", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
    "已存在",
  );
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await page.reload();
  await page.getByRole("button", { name: "展开 Work", exact: true }).click();
  await expect(
    page.getByRole("treeitem", { name: "done.md", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("treeitem", { name: "a.md", exact: true }),
  ).toBeVisible();
});

test("single click opens files and toggles folders, modifier clicks only select", async ({
  page,
}) => {
  const item = (name: string) =>
    page.getByRole("treeitem", { name, exact: true });
  const row = (name: string) => item(name).locator(".tree-row").first();
  const pane = page.getByRole("region", { name: "文件编辑器" });

  await item("a.md").click();
  await expect(pane).toContainText("# a.md");

  // 修饰键点击只改变选择，不打开文件，与 Zed 一致。
  await item("b.md").click({ modifiers: ["Control"] });
  await expect(treeStatus(page)).toHaveText("已选择 2 项");
  await expect(pane).toContainText("# a.md");
  await expect(pane).not.toContainText("# b.md");
  await item("c.md").click({ modifiers: ["Shift"] });
  await expect(pane).not.toContainText("# c.md");

  // 单击文件夹展开，再次单击折叠；展开后的 treeitem 比行高，
  // 必须点在行上，否则会落在空白处变成清空选择。
  await row("Inbox").click();
  await expect(item("Inbox")).toHaveAttribute("aria-expanded", "true");
  await expect(item("alpha.md")).toBeVisible();
  await expect(pane).not.toContainText("# Inbox/alpha.md");
  await row("Inbox").click();
  await expect(item("Inbox")).toHaveAttribute("aria-expanded", "false");
  await expect(item("alpha.md")).toBeHidden();
});

test("a click that follows a pointer drag does not open or expand", async ({
  page,
}) => {
  const item = (name: string) =>
    page.getByRole("treeitem", { name, exact: true });
  const row = (name: string) => item(name).locator(".tree-row").first();
  const pane = page.getByRole("region", { name: "文件编辑器" });

  // 拖拽移动文件：松手后不得再把落点当作单击把文件打开（悬停展开是另一套机制）。
  const source = (await row("a.md").boundingBox())!;
  const target = (await row("Archive").boundingBox())!;
  await page.mouse.move(
    source.x + source.width / 2,
    source.y + source.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    target.x + target.width / 2,
    target.y + target.height / 2,
    { steps: 8 },
  );
  await page.mouse.up();
  await expect(row("a.md")).toHaveAttribute("data-path", "Archive/a.md");
  await expect(pane).toContainText("打开一份文件");

  // 浏览器可能在拖动后补发 click；坐标已偏移时按拖动处理，原位点击仍然展开。
  await row("Inbox").dispatchEvent("pointerdown", {
    clientX: 120,
    clientY: 120,
    button: 0,
    buttons: 1,
    isPrimary: true,
  });
  await row("Inbox").dispatchEvent("click", {
    clientX: 260,
    clientY: 200,
    button: 0,
  });
  await expect(item("Inbox")).toHaveAttribute("aria-expanded", "false");
  await row("Inbox").dispatchEvent("pointerdown", {
    clientX: 120,
    clientY: 120,
    button: 0,
    buttons: 1,
    isPrimary: true,
  });
  await row("Inbox").dispatchEvent("click", {
    clientX: 120,
    clientY: 120,
    button: 0,
  });
  await expect(item("Inbox")).toHaveAttribute("aria-expanded", "true");
});

test("multi-item dragging moves to folders and rejects moving a folder inside itself", async ({
  page,
}) => {
  const row = (name: string) =>
    page
      .getByRole("treeitem", { name, exact: true })
      .locator(".tree-row")
      .first();
  await row("a.md").click();
  await row("c.md").click({ modifiers: ["Control"] });
  await row("a.md").dragTo(row("Archive"));
  await expect(row("a.md")).toHaveAttribute("data-path", "Archive/a.md");
  await expect(row("c.md")).toHaveAttribute("data-path", "Archive/c.md");
  await page.getByRole("button", { name: "展开 Inbox", exact: true }).click();
  await row("Inbox").dragTo(row("Nested"));
  await expect(row("Inbox")).toHaveAttribute("data-path", "Inbox");
  await expect(row("alpha.md")).toHaveAttribute("data-path", "Inbox/alpha.md");
  const paths = await page.evaluate(async () => {
    const url = "/src/lib/vault/index.ts";
    const { openOpfsVault, vaultPath } = (await import(url)) as VaultModule;
    const backend = await openOpfsVault();
    const result = {
      old: await backend.stat(vaultPath("a.md")),
      moved: await backend.stat(vaultPath("Archive/a.md")),
      directory: await backend.stat(vaultPath("Inbox/Nested")),
    };
    await backend.close();
    return result;
  });
  expect(paths.old).toBeNull();
  expect(paths.moved?.kind).toBe("file");
  expect(paths.directory?.kind).toBe("directory");
});

test("dragging highlights only the destination subtree and clears it on exit", async ({
  page,
}) => {
  const item = (name: string) =>
    page.getByRole("treeitem", { name, exact: true });
  const row = (name: string) => item(name).locator(".tree-row").first();
  const root = page.locator(".tree-region");
  await page.getByRole("button", { name: "展开 Inbox", exact: true }).click();
  await row("a.md").click();
  await row("c.md").click({ modifiers: ["Control"] });
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  try {
    await row("a.md").dispatchEvent("dragstart", { dataTransfer });
    await row("Inbox").dispatchEvent("dragover", {
      dataTransfer,
      clientX: 140,
      clientY: 170,
    });
    await expect(item("Inbox")).toHaveAttribute("data-drop", "true");
    await expect(item("Inbox")).toHaveCSS("isolation", "isolate");
    const highlight = await item("Inbox").evaluate((element) => {
      const style = getComputedStyle(element, "::before");
      return {
        content: style.content,
        background: style.backgroundColor,
        border: style.boxShadow,
      };
    });
    expect(highlight.content).toBe('""');
    expect(highlight.background).not.toBe("rgba(0, 0, 0, 0)");
    expect(highlight.border).toContain("2px");
    await expect(item("Archive")).toHaveAttribute("data-drop", "false");
    await expect(root).toHaveAttribute("data-drop", "false");
    await expect(treeStatus(page)).toHaveText("已选择 2 项");

    // A file resolves to its parent subtree, rather than becoming a drop target itself.
    await row("alpha.md").dispatchEvent("dragover", {
      dataTransfer,
      clientX: 140,
      clientY: 210,
    });
    await expect(item("Inbox")).toHaveAttribute("data-drop", "true");
    await expect(item("alpha.md")).toHaveAttribute("data-drop", "false");
    await row("alpha.md").evaluate((element) =>
      element.dispatchEvent(
        new DragEvent("dragleave", {
          bubbles: true,
          relatedTarget: document.querySelector('[data-path="Inbox/Nested"]'),
        }),
      ),
    );
    await expect(item("Inbox")).toHaveAttribute("data-drop", "true");

    await row("Nested").dispatchEvent("dragover", {
      dataTransfer,
      clientX: 140,
      clientY: 200,
    });
    await expect(item("Nested")).toHaveAttribute("data-drop", "true");
    await expect(item("Inbox")).toHaveAttribute("data-drop", "false");
    await row("a.md").dispatchEvent("dragend", { dataTransfer });
    await expect(item("Nested")).toHaveAttribute("data-drop", "false");

    await row("alpha.md").click();
    await row("alpha.md").dispatchEvent("dragstart", { dataTransfer });
    await page
      .locator(".tree-root")
      .dispatchEvent("dragover", { dataTransfer });
    await expect(root).toHaveAttribute("data-drop", "true");
    await row("b.md").dispatchEvent("dragover", { dataTransfer });
    await expect(root).toHaveAttribute("data-drop", "true");
    await expect(item("b.md")).toHaveAttribute("data-drop", "false");
    await page
      .locator(".tree-toolbar")
      .dispatchEvent("dragover", { dataTransfer });
    await expect(root).toHaveAttribute("data-drop", "false");
    await row("b.md").dispatchEvent("dragover", { dataTransfer });
    await page
      .locator(".file-tree")
      .dispatchEvent("dragleave", { relatedTarget: null });
    await expect(root).toHaveAttribute("data-drop", "false");

    // Same-directory and self-descendant drops have no highlighted destination.
    await row("Inbox").dispatchEvent("dragover", { dataTransfer });
    await expect(item("Inbox")).toHaveAttribute("data-drop", "false");
    expect(await dataTransfer.evaluate((transfer) => transfer.dropEffect)).toBe(
      "none",
    );
    await row("alpha.md").dispatchEvent("dragend", { dataTransfer });
    // Inbox 处于展开态：单击会折叠并选中，再单击恢复展开，Nested 才能作为落点行。
    await row("Inbox").click();
    await expect(item("Inbox")).toHaveAttribute("aria-expanded", "false");
    await row("Inbox").click();
    await expect(item("Inbox")).toHaveAttribute("aria-expanded", "true");
    await row("Inbox").dispatchEvent("dragstart", { dataTransfer });
    await row("Nested").dispatchEvent("dragover", { dataTransfer });
    await expect(item("Nested")).toHaveAttribute("data-drop", "false");
    expect(await dataTransfer.evaluate((transfer) => transfer.dropEffect)).toBe(
      "none",
    );
    await row("Inbox").dispatchEvent("dragend", { dataTransfer });
  } finally {
    await dataTransfer.dispose();
  }
});

test("cut/paste and move dialog provide keyboard alternatives to dragging", async ({
  page,
}) => {
  const tree = page.getByRole("tree", { name: "文件树" });
  const b = page.getByRole("treeitem", { name: "b.md", exact: true });
  await b.click();
  // 单击会打开文件，焦点随后跟随编辑器（与 Zed 一致）；等编辑器就绪后
  // 再聚焦文件树，继续使用文件树快捷键才不会落在编辑器里。
  await expect(page.getByRole("textbox", { name: "代码编辑器" })).toBeVisible();
  await tree.focus();
  await page.keyboard.press("Control+x");
  await expect(b.locator(".tree-row")).toHaveAttribute("data-cut", "true");
  await page.keyboard.press("Control+Home");
  await page.keyboard.press("Control+v");
  await expect(b.locator(".tree-row")).toHaveAttribute(
    "data-path",
    "Archive/b.md",
  );
  await expect(tree).toBeFocused();
  await page
    .getByRole("treeitem", { name: "a.md", exact: true })
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: "移动到…" }).click();
  await page.getByRole("textbox", { name: "目标文件夹路径" }).fill("Archive");
  await page.getByRole("button", { name: "确认", exact: true }).click();
  await expect(
    page
      .getByRole("treeitem", { name: "a.md", exact: true })
      .locator(".tree-row"),
  ).toHaveAttribute("data-path", "Archive/a.md");
});

test("delete confirmation snapshots the selection, cancels safely, and deletes selected parents once", async ({
  page,
}) => {
  // 单击行即展开并选中 Inbox，不必先点折叠箭头；再按会折叠。
  await page
    .getByRole("treeitem", { name: "Inbox", exact: true })
    .locator(".tree-row")
    .first()
    .click();
  await expect(
    page.getByRole("treeitem", { name: "Inbox", exact: true }),
  ).toHaveAttribute("aria-expanded", "true");
  await page
    .getByRole("treeitem", { name: "alpha.md", exact: true })
    .click({ modifiers: ["Control"] });
  await page.keyboard.press("Delete");
  await expect(page.getByRole("dialog", { name: "删除 1 项" })).toBeVisible();
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await expect(
    page.getByRole("treeitem", { name: "alpha.md", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Delete");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "删除", exact: true })
    .click();
  await expect(
    page.getByRole("treeitem", { name: "Inbox", exact: true }),
  ).toBeHidden();
  await page.reload();
  await expect(
    page.getByRole("treeitem", { name: "Inbox", exact: true }),
  ).toBeHidden();
});

test("copy/paste preserves originals and creates unique same-folder copies", async ({
  page,
}) => {
  await page.getByRole("treeitem", { name: "a.md", exact: true }).click();
  // 单击打开后焦点可能跟随编辑器，剪贴板快捷键前先聚焦文件树。
  await expect(page.getByRole("textbox", { name: "代码编辑器" })).toBeVisible();
  await page.getByRole("tree", { name: "文件树" }).focus();
  await page.keyboard.press("Control+c");
  await page.keyboard.press("Control+v");
  await expect(
    page.getByRole("treeitem", { name: "a 副本.md", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Control+v");
  await expect(
    page.getByRole("treeitem", { name: "a 副本 2.md", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("treeitem", { name: "a.md", exact: true }),
  ).toBeVisible();
});

test("file imports, editor contents and partial move failure reflect actual storage", async ({
  page,
}) => {
  await page.getByLabel("选择要导入的文件").setInputFiles({
    name: "import.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("imported"),
  });
  await page.getByRole("treeitem", { name: "import.txt", exact: true }).click();
  await expect(page.getByRole("region", { name: "文件编辑器" })).toContainText(
    "imported",
  );
  // 独立注入真实 OPFS 写入失败，第二项出错时第一项必须可见。
  await page.evaluate(() => {
    const original = FileSystemFileHandle.prototype.createWritable;
    (window as unknown as { restoreWriter: () => void }).restoreWriter = () => {
      FileSystemFileHandle.prototype.createWritable = original;
    };
    FileSystemFileHandle.prototype.createWritable = async function (options) {
      const writable = await original.call(this, options);
      if (this.name === "b.md")
        writable.write = async () => {
          throw new DOMException("Injected quota error", "QuotaExceededError");
        };
      return writable;
    };
  });
  try {
    await page.getByRole("treeitem", { name: "a.md", exact: true }).click();
    await page
      .getByRole("treeitem", { name: "b.md", exact: true })
      .click({ modifiers: ["Control"] });
    await page
      .getByRole("treeitem", { name: "a.md", exact: true })
      .click({ button: "right" });
    await page.getByRole("menuitem", { name: "移动到…" }).click();
    await page.getByRole("textbox", { name: "目标文件夹路径" }).fill("Archive");
    await page.getByRole("button", { name: "确认", exact: true }).click();
    await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
      "已完成 1 项",
    );
    await page.getByRole("button", { name: "取消", exact: true }).click();
    await expect(
      page
        .getByRole("treeitem", { name: "a.md", exact: true })
        .locator(".tree-row"),
    ).toHaveAttribute("data-path", "Archive/a.md");
    await expect(
      page
        .getByRole("treeitem", { name: "b.md", exact: true })
        .locator(".tree-row"),
    ).toHaveAttribute("data-path", "b.md");
  } finally {
    await page.evaluate(() =>
      (window as unknown as { restoreWriter: () => void }).restoreWriter(),
    );
  }
});

test("mobile tree fits the viewport and theme applies to rows and operation dialogs", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 720 });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(360);
  await expect(page.getByRole("tree", { name: "文件树" })).toBeVisible();
  await page.getByRole("button", { name: "主题", exact: true }).click();
  await page.getByRole("menuitem", { name: "深色", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByRole("button", { name: "新建文件", exact: true }).click();
  const surface = await page
    .locator(".vault-editor")
    .evaluate((element) => getComputedStyle(element).backgroundColor);
  await expect(page.getByRole("dialog")).toHaveCSS("background-color", surface);
});
