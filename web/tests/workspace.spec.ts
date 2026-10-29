import { expect, test as base } from "@playwright/test";
import type { EditorView } from "@codemirror/view";
import { chooseEditorMode } from "./editor-actions";
import { openVaultManager, vaultSwitcher } from "./vault-actions";

const test = base.extend<{ runtimeErrors: string[] }>({
  runtimeErrors: [
    async ({ page }, use) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => {
        const diagnostic = message.text();
        const workspaceRead =
          diagnostic.includes("[STRICT_READ_UNTRACKED]") &&
          /in .*<VaultWorkspace>\s*(?:\n|$)/.test(diagnostic);
        const vaultDialogFeedback =
          /\[(EFFECT_WRITES_OWN_SOURCE|EFFECT_RELAY_TEAR)\]/.test(diagnostic) &&
          diagnostic.includes("<VaultConnections> › <Dialog> › effect");
        if (message.type() === "error" || workspaceRead || vaultDialogFeedback)
          errors.push(message.text());
      });
      await use(errors);
      expect(errors).toEqual([]);
    },
    { auto: true },
  ],
});

test.beforeEach(async ({ page }) => {
  // 每个测试都是新的浏览器上下文，OPFS 与 localStorage 起始为空，无需预清理；
  // addInitScript 会在 reload 时再次执行，反而会清掉要持久化的宽度。
  await page.goto("/");
  await expect(page.getByRole("tree", { name: "文件树" })).toHaveAttribute(
    "aria-busy",
    "false",
  );
});

const sidebar = (page: import("@playwright/test").Page) =>
  page.locator(".workspace-sidebar");
const divider = (page: import("@playwright/test").Page) =>
  page.getByRole("separator", { name: "调整侧边栏宽度" });
const storedWidth = (page: import("@playwright/test").Page) =>
  page.evaluate(async () => {
    try {
      const root = await navigator.storage.getDirectory();
      const directory = await root.getDirectoryHandle("celestite");
      const file = await directory.getFileHandle("settings.json");
      const text = await (await file.getFile()).text();
      return JSON.parse(text)["sidebar.width"] ?? null;
    } catch {
      // 文件还没落盘；轮询会继续等。
      return null;
    }
  });

test("the sidebar keeps its default width and exposes a labelled divider", async ({
  page,
}) => {
  await expect(divider(page)).toBeVisible();
  await expect(divider(page)).toHaveAttribute("aria-orientation", "vertical");
  await expect(divider(page)).toHaveAttribute("aria-valuemin", "200");
  await expect(divider(page)).toHaveAttribute("aria-valuemax", "560");
  await expect(sidebar(page)).toHaveCSS("width", "248px");
  const logo = sidebar(page).locator(".vault-brand-icon");
  await expect(logo).toHaveAttribute("src", /\/icons\/64x64\.png(?:\?|$)/);
  expect(
    await logo.evaluate(
      (element) => (element as HTMLImageElement).naturalWidth,
    ),
  ).toBe(64);
  await expect(page.getByRole("tree", { name: "文件树" })).toBeVisible();
  await expect(page.getByRole("region", { name: "文件编辑器" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "收起文件导航", exact: true }),
  ).toHaveCount(0);
});

test("the vault dialog can reopen without reactive feedback and restores focus", async ({
  page,
}) => {
  const dialog = page.getByRole("dialog");
  for (let attempt = 0; attempt < 3; attempt++) {
    await openVaultManager(page);
    await expect(dialog).toBeVisible();
    if (attempt === 1) await page.keyboard.press("Escape");
    else
      await dialog
        .getByRole("button", { name: "关闭弹窗", exact: true })
        .click();
    await expect(dialog).toBeHidden();
    await expect(vaultSwitcher(page)).toBeFocused();
  }
  await expect(page.getByRole("tree", { name: "文件树" })).toBeVisible();
});

test("opening a local directory from the empty state clears a previous picker error", async ({
  page,
}) => {
  await page.evaluate(async () => {
    let attempts = 0;
    const root = await navigator.storage.getDirectory();
    const directory = await root.getDirectoryHandle("My notes", {
      create: true,
    });
    Object.defineProperty(window, "showDirectoryPicker", {
      configurable: true,
      value: async () => {
        if (attempts++ === 0) throw new Error("请选择可访问的目录");
        return directory;
      },
    });
  });
  const open = page.getByRole("button", { name: "打开本机目录", exact: true });
  await open.click();
  await expect(page.getByRole("alert")).toContainText("选择本机目录 failed");
  await open.click();
  await expect(vaultSwitcher(page)).toContainText("My notes");
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(
    page.getByText("笔记保存在本机，编辑后会自动保存。", { exact: true }),
  ).toBeVisible();
});

test("the panels start at the top and share a full-width bottom status bar", async ({
  page,
}) => {
  const bar = page.getByLabel("工作区状态栏");
  const bounds = (await bar.boundingBox())!;
  const viewport = page.viewportSize()!;
  expect(bounds.x).toBe(0);
  expect(bounds.width).toBe(viewport.width);
  expect(bounds.y + bounds.height).toBe(viewport.height);
  expect((await sidebar(page).boundingBox())!.y).toBe(0);
  expect((await sidebar(page).boundingBox())!.height).toBe(bounds.y);
  await expect(bar.getByRole("status", { name: "文件树状态" })).toHaveText(
    "准备就绪",
  );
  await expect(bar.getByRole("button", { name: "主题" })).toHaveCount(0);
  await expect(vaultSwitcher(page)).toBeVisible();
  await sidebar(page).getByRole("button", { name: "主题" }).click();
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  const menuBounds = (await menu.boundingBox())!;
  expect(menuBounds.y + menuBounds.height).toBeLessThanOrEqual(bounds.y);
  await page.getByRole("menuitem", { name: "深色", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});

test("dragging the divider resizes the sidebar and persists across reloads", async ({
  page,
}) => {
  const handle = divider(page);
  const box = (await handle.boundingBox())!;
  const centerY = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width / 2, centerY);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 80, centerY, { steps: 8 });
  await expect(sidebar(page)).toHaveCSS("width", "328px");
  await expect(handle).toHaveAttribute("data-dragging", "true");
  await expect(handle).toHaveAttribute("aria-valuenow", "328");
  await page.mouse.up();
  await expect(sidebar(page)).toHaveCSS("width", "328px");
  // 落盘是异步的（createWritable），用轮询等文件出现。
  await expect.poll(() => storedWidth(page)).toBe(328);
  await expect(handle).toHaveAttribute("data-dragging", "false");
  await expect(page.getByRole("tree", { name: "文件树" })).toBeVisible();
  await page.reload();
  await expect(sidebar(page)).toHaveCSS("width", "328px");
});

test("the divider is keyboard operable, clamps to its limits and follows the viewport", async ({
  page,
}) => {
  const handle = divider(page);
  await handle.focus();
  await page.keyboard.press("ArrowRight");
  await expect(sidebar(page)).toHaveCSS("width", "264px");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await expect(sidebar(page)).toHaveCSS("width", "232px");
  await page.keyboard.press("Home");
  await expect(sidebar(page)).toHaveCSS("width", "200px");
  await page.keyboard.press("ArrowLeft");
  await expect(sidebar(page)).toHaveCSS("width", "200px");
  await page.keyboard.press("End");
  await expect(sidebar(page)).toHaveCSS("width", "560px");
  await expect.poll(() => storedWidth(page)).toBe(560);
  await page.setViewportSize({ width: 720, height: 720 });
  await expect(sidebar(page)).toHaveCSS("width", "432px");
  await expect(page.getByRole("tree", { name: "文件树" })).toBeVisible();
});

test("the mobile navigation drawer traps focus and Escape returns to its opener", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 720 });
  await expect(divider(page)).toBeHidden();
  await expect(page.getByRole("tree", { name: "文件树" })).toBeHidden();
  await expect(page.getByRole("region", { name: "文件编辑器" })).toBeVisible();
  await expect(page.getByLabel("工作区状态栏")).toBeVisible();
  const opener = page.getByRole("button", {
    name: "切换文件导航",
    exact: true,
  });
  await opener.click();
  const drawer = page.getByRole("dialog", { name: "文件导航", exact: true });
  await expect(drawer).toBeVisible();
  await expect(drawer).toHaveAttribute("aria-modal", "true");
  const first = drawer.getByRole("button", {
    name: "当前 Vault",
    exact: true,
  });
  const last = drawer.getByRole("button", { name: "主题", exact: true });
  await expect(first).toBeFocused();
  expect(
    await page
      .locator(".workspace-editor-pane")
      .evaluate((element) => (element as HTMLElement).inert),
  ).toBe(true);
  await last.focus();
  await page.keyboard.press("Tab");
  await expect(first).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(last).toBeFocused();
  // A drawer is navigation, not a second modal that blocks filename lookup.
  await page.keyboard.press("Control+k");
  const finder = page.getByRole("dialog", { name: "查找文件", exact: true });
  await expect(finder).toBeVisible();
  await expect(
    finder.getByRole("combobox", { name: "文件名或路径", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(finder).toBeHidden();
  await expect(last).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();
  await expect(opener).toBeFocused();
  expect(
    await page
      .locator(".workspace-editor-pane")
      .evaluate((element) => (element as HTMLElement).inert),
  ).toBe(false);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(360);
});

test("sidebar and focus transitions preserve the same editor, document and selection", async ({
  page,
}) => {
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const vaults = await root.getDirectoryHandle("vaults");
    const vault = await vaults.getDirectoryHandle("default");
    const file = await vault.getFileHandle("writing.md", { create: true });
    const writable = await file.createWritable();
    await writable.write(
      "# 写作测试\n\n保持这段文字与选区。\n\n下一段内容。\n",
    );
    await writable.close();
  });
  await page.reload();
  await page.getByRole("treeitem", { name: "writing.md", exact: true }).click();
  await chooseEditorMode(page, "实时渲染");
  const content = page.getByRole("textbox", {
    name: "代码编辑器",
    exact: true,
  });
  await expect(content).toBeVisible();
  await expect(content.locator(".cm-live-heading")).toBeVisible();
  await content.evaluate((element) => {
    const view = (
      element as HTMLElement & { cmTile: { root: { view: EditorView } } }
    ).cmTile.root.view;
    view.dispatch({ selection: { anchor: 10, head: 15 } });
    (
      window as unknown as {
        workspaceEditor: { view: EditorView; doc: EditorView["state"]["doc"] };
      }
    ).workspaceEditor = { view, doc: view.state.doc };
  });
  const unchanged = async () => {
    expect(
      await content.evaluate((element) => {
        const view = (
          element as HTMLElement & { cmTile: { root: { view: EditorView } } }
        ).cmTile.root.view;
        const saved = (
          window as unknown as {
            workspaceEditor: {
              view: EditorView;
              doc: EditorView["state"]["doc"];
            };
          }
        ).workspaceEditor;
        return {
          sameView: saved.view === view,
          sameDoc: saved.doc === view.state.doc,
          anchor: view.state.selection.main.anchor,
          head: view.state.selection.main.head,
          text: view.state.doc.toString(),
        };
      }),
    ).toEqual({
      sameView: true,
      sameDoc: true,
      anchor: 10,
      head: 15,
      text: "# 写作测试\n\n保持这段文字与选区。\n\n下一段内容。\n",
    });
  };
  await page.getByRole("button", { name: "切换文件导航", exact: true }).click();
  await expect(sidebar(page)).toBeHidden();
  await expect(
    page.getByRole("button", { name: "切换文件导航", exact: true }),
  ).toBeFocused();
  await unchanged();
  await page.getByRole("button", { name: "切换文件导航", exact: true }).click();
  await expect(sidebar(page)).toBeVisible();
  await unchanged();
  await page.getByRole("button", { name: "专注写作", exact: true }).click();
  await expect(page.locator(".workspace")).toHaveAttribute(
    "data-focus",
    "true",
  );
  await expect(sidebar(page)).toBeHidden();
  await unchanged();
  await page.keyboard.press("Escape");
  await expect(page.locator(".workspace")).toHaveAttribute(
    "data-focus",
    "false",
  );
  await expect(sidebar(page)).toBeVisible();
  await unchanged();
  await page.setViewportSize({ width: 700, height: 720 });
  const drawerOpener = page.getByRole("button", {
    name: "切换文件导航",
    exact: true,
  });
  await drawerOpener.click();
  await expect(
    page.getByRole("dialog", { name: "文件导航", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(drawerOpener).toBeFocused();
  await unchanged();
  await content.focus();
  await page.keyboard.press("Control+k");
  await expect(
    page.getByRole("dialog", { name: "查找文件", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("combobox", { name: "文件名或路径", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(content).toBeFocused();
  await unchanged();
  // Selecting an already mounted document must hand focus back as well.
  await page.keyboard.press("Control+k");
  const finder = page.getByRole("dialog", { name: "查找文件", exact: true });
  await finder
    .getByRole("combobox", { name: "文件名或路径", exact: true })
    .fill("writing.md");
  await finder
    .getByRole("combobox", { name: "文件名或路径", exact: true })
    .press("Enter");
  await expect(finder).toBeHidden();
  await expect(content).toBeFocused();
  await unchanged();
  await page.keyboard.insertText("继续");
  await expect(content).toContainText("继续");
});
