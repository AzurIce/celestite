import { expect, test as base, type Page } from "@playwright/test";
import { installWorkerHarness, workerEvaluate } from "./worker-harness";
type VaultModule = typeof import("../src/lib/vault");

const original = "alpha beta\nsecond line\nthird line\n";
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
  await expect(page.getByLabel("工作区状态栏")).toBeVisible();
  await page.evaluate(async (content) => {
    const root = await navigator.storage.getDirectory();
    const app = await root.getDirectoryHandle("celestite", { create: true });
    const file = await app.getFileHandle("settings.json", { create: true });
    const writable = await file.createWritable();
    await writable.write(JSON.stringify({ "editor.vimMode": true }));
    await writable.close();
    const { openOpfsVault, vaultPath } = (await import(
      "/src/lib/vault/index.ts" as string
    )) as VaultModule;
    const vault = await openOpfsVault();
    await vault.writeFile(
      vaultPath("a.md"),
      new TextEncoder().encode(content),
      { mode: "create" },
    );
    await vault.writeFile(
      vaultPath("b.ts"),
      new TextEncoder().encode("const value = 1;\n"),
      { mode: "create" },
    );
    await vault.close();
  }, original);
  await page.goto("/");
  await page.getByRole("treeitem", { name: "a.md", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "代码编辑器" })).toContainText(
    "alpha beta",
  );
  await expect(
    page.getByRole("status", { name: "Vim 模式", exact: true }),
  ).toHaveText("NORMAL");
});

const editor = (page: Page) =>
  page.getByRole("textbox", { name: "代码编辑器" });
const mode = (page: Page) =>
  page.getByRole("status", { name: "Vim 模式", exact: true });

async function ex(page: Page, command: string) {
  await editor(page).press(":");
  const input = page.locator(".cm-vim-panel input");
  await expect(input).toBeFocused();
  await input.fill(command);
  await input.press("Enter");
}

async function toggleVim(page: Page, enabled: boolean) {
  await page.getByRole("button", { name: "全局设置", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "全局设置", exact: true });
  await dialog
    .getByRole("checkbox", { name: "Vim 模式", exact: true })
    .setChecked(enabled);
  await expect(dialog.getByRole("status", { name: "设置保存状态" })).toHaveText(
    "已保存",
  );
  await dialog.getByRole("button", { name: "关闭弹窗" }).click();
  await editor(page).focus();
}

async function readFile(page: Page, path = "a.md") {
  return page.evaluate(async (path) => {
    const { openOpfsVault, vaultPath } = (await import(
      "/src/lib/vault/index.ts" as string
    )) as VaultModule;
    const vault = await openOpfsVault();
    const bytes = await vault.readFile(vaultPath(path));
    await vault.close();
    return new TextDecoder().decode(bytes);
  }, path);
}

test("normal motions, visual selection, insert mode and Ctrl+S work", async ({
  page,
}) => {
  await editor(page).press("j");
  await expect(page.getByText("Ln 2, Col 1", { exact: true })).toBeVisible();
  await editor(page).press("v");
  await expect(mode(page)).toHaveText("VISUAL");
  await editor(page).press("w");
  await editor(page).press("Escape");
  await expect(mode(page)).toHaveText("NORMAL");
  await editor(page).press("i");
  await expect(mode(page)).toHaveText("INSERT");
  await page.keyboard.insertText("vim ");
  await editor(page).press("Escape");
  await expect(mode(page)).toHaveText("NORMAL");
  await editor(page).press("Control+s");
  await expect(page.getByRole("status", { name: "保存状态" })).toHaveText(
    "已保存",
  );
  expect(await readFile(page)).toContain("vim ");
});

test("separate delete commands use core undo and redo even when issued quickly", async ({
  page,
}) => {
  await editor(page).pressSequentially("dd");
  await expect(editor(page)).toHaveText("second linethird line");
  await editor(page).pressSequentially("dd");
  await expect(editor(page)).toHaveText("third line");
  await editor(page).press("u");
  await expect(editor(page)).toHaveText("second linethird line");
  await editor(page).press("u");
  await expect(editor(page)).toHaveText("alpha betasecond linethird line");
  await expect(mode(page)).toHaveText("NORMAL");
  await editor(page).press("Control+r");
  await expect(editor(page)).toHaveText("second linethird line");
  await editor(page).press("Control+r");
  await expect(editor(page)).toHaveText("third line");
});

test("insert sessions stay separate and ex undo/redo use the same history", async ({
  page,
}) => {
  await editor(page).press("i");
  await editor(page).pressSequentially("one ");
  await editor(page).press("Escape");
  await editor(page).press("A");
  await editor(page).pressSequentially(" two");
  await editor(page).press("Escape");
  await expect(editor(page)).toContainText("one alpha beta two");
  await ex(page, "undo");
  await expect(editor(page)).toContainText("one alpha beta");
  await expect(editor(page)).not.toContainText("two");
  await editor(page).press("u");
  await expect(editor(page)).toHaveText("alpha betasecond linethird line");
  await ex(page, "redo");
  await expect(editor(page)).toContainText("one alpha beta");
});

test("Vim search and substitutions edit the document through core transactions", async ({
  page,
}) => {
  await editor(page).press("/");
  const input = page.locator(".cm-vim-panel input");
  await input.fill("second");
  await input.press("Enter");
  await expect(page.getByText("Ln 2, Col 1", { exact: true })).toBeVisible();
  await ex(page, "%s/line/row/g");
  await expect(editor(page)).toHaveText("alpha betasecond rowthird row");
  await editor(page).press("u");
  await expect(editor(page)).toHaveText("alpha betasecond linethird line");
});

test("live toggles preserve text and undo history across cached tab switches and reload", async ({
  page,
}) => {
  await editor(page).press("i");
  await page.keyboard.insertText("keep ");
  await editor(page).press("Escape");
  await page.getByRole("treeitem", { name: "b.ts", exact: true }).click();
  await expect(editor(page)).toContainText("const value = 1;");
  await toggleVim(page, false);
  await expect(mode(page)).toHaveCount(0);
  await page.getByRole("tab", { name: "a.md", exact: true }).click();
  await expect(editor(page)).toContainText("keep alpha beta");
  await editor(page).press("Control+z");
  await expect(editor(page)).toHaveText("alpha betasecond linethird line");
  await toggleVim(page, true);
  await expect(mode(page)).toHaveText("NORMAL");
  await editor(page).press("Control+r");
  await expect(editor(page)).toContainText("keep alpha beta");
  await ex(page, "w");
  await expect(page.getByRole("status", { name: "保存状态" })).toHaveText(
    "已保存",
  );
  await page.reload();
  await page.getByRole("treeitem", { name: "a.md", exact: true }).click();
  await expect(mode(page)).toHaveText("NORMAL");
  await expect(editor(page)).toContainText("keep alpha beta");
});

test(":q rejects unsaved edits and :wq saves and closes only its own tab", async ({
  page,
}) => {
  await page.getByRole("treeitem", { name: "b.ts", exact: true }).click();
  await page.getByRole("tab", { name: "a.md", exact: true }).click();
  await editor(page).press("i");
  await page.keyboard.insertText("save me ");
  await editor(page).press("Escape");
  await ex(page, "q");
  await expect(page.getByRole("alert")).toContainText("文件尚未保存");
  await expect(
    page.getByRole("tab", { name: "a.md", exact: true }),
  ).toBeVisible();
  await ex(page, "wq");
  await expect(
    page.getByRole("tab", { name: "a.md", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("tab", { name: "b.ts", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  expect(await readFile(page)).toBe("save me " + original);
});

test(":wq keeps the tab and draft when saving fails", async ({ page }) => {
  await workerEvaluate(page, () => {
    const original = FileSystemFileHandle.prototype.createWritable;
    FileSystemFileHandle.prototype.createWritable = async function (options) {
      if (this.name === "a.md")
        throw new DOMException("Injected quota failure", "QuotaExceededError");
      return original.call(this, options);
    };
  });
  await editor(page).press("i");
  await page.keyboard.insertText("draft ");
  await editor(page).press("Escape");
  await ex(page, "wq");
  await expect(page.getByRole("status", { name: "保存状态" })).toHaveText(
    "保存失败",
  );
  await expect(
    page.getByRole("tab", { name: "a.md", exact: true }),
  ).toBeVisible();
  await expect(editor(page)).toContainText("draft alpha beta");
  expect(await readFile(page)).toBe(original);
});

test(":w preserves conflict handling and cancellation keeps local edits", async ({
  page,
}) => {
  await page.evaluate(async () => {
    const { openOpfsVault, vaultPath } = (await import(
      "/src/lib/vault/index.ts" as string
    )) as VaultModule;
    const vault = await openOpfsVault();
    await vault.writeFile(
      vaultPath("a.md"),
      new TextEncoder().encode("external"),
      { mode: "replace" },
    );
    await vault.close();
  });
  await editor(page).press("i");
  await page.keyboard.insertText("draft ");
  await editor(page).press("Escape");
  await ex(page, "w");
  await expect(page.getByRole("dialog")).toContainText("文件已在磁盘上修改");
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(editor(page)).toContainText("draft alpha beta");
  expect(await readFile(page)).toBe("external");
});
