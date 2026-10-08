import { expect, test as base } from "@playwright/test";

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

const widthKey = "celestite.workspace.sidebarWidth";

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
  await expect(sidebar(page)).toHaveCSS("width", "300px");
  await expect(page.getByRole("tree", { name: "文件树" })).toBeVisible();
  await expect(page.getByRole("region", { name: "文件编辑器" })).toBeVisible();
});

test("the vault dialog can reopen without reactive feedback and restores focus", async ({
  page,
}) => {
  const trigger = page.getByRole("button", { name: "管理 Vault", exact: true });
  const dialog = page.getByRole("dialog");
  for (let attempt = 0; attempt < 3; attempt++) {
    await trigger.click();
    await expect(dialog).toBeVisible();
    if (attempt === 1) await page.keyboard.press("Escape");
    else
      await dialog
        .getByRole("button", { name: "关闭弹窗", exact: true })
        .click();
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
  }
  await expect(page.getByRole("tree", { name: "文件树" })).toBeVisible();
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
  await expect(bar.getByRole("button", { name: "主题" })).toBeVisible();
  await bar.getByRole("button", { name: "主题" }).click();
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
  await expect(sidebar(page)).toHaveCSS("width", "380px");
  await expect(handle).toHaveAttribute("data-dragging", "true");
  await expect(handle).toHaveAttribute("aria-valuenow", "380");
  await page.mouse.up();
  await expect(sidebar(page)).toHaveCSS("width", "380px");
  // 落盘是异步的（createWritable），用轮询等文件出现。
  await expect.poll(() => storedWidth(page)).toBe(380);
  await expect(handle).toHaveAttribute("data-dragging", "false");
  await expect(page.getByRole("tree", { name: "文件树" })).toBeVisible();
  await page.reload();
  await expect(sidebar(page)).toHaveCSS("width", "380px");
});

test("the divider is keyboard operable, clamps to its limits and follows the viewport", async ({
  page,
}) => {
  const handle = divider(page);
  await handle.focus();
  await page.keyboard.press("ArrowRight");
  await expect(sidebar(page)).toHaveCSS("width", "316px");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await expect(sidebar(page)).toHaveCSS("width", "284px");
  await page.keyboard.press("Home");
  await expect(sidebar(page)).toHaveCSS("width", "200px");
  await page.keyboard.press("ArrowLeft");
  await expect(sidebar(page)).toHaveCSS("width", "200px");
  await page.keyboard.press("End");
  await expect(sidebar(page)).toHaveCSS("width", "560px");
  await expect.poll(() => storedWidth(page)).toBe(560);
  await page.setViewportSize({ width: 700, height: 720 });
  await expect(sidebar(page)).toHaveCSS("width", "420px");
  await expect(page.getByRole("tree", { name: "文件树" })).toBeVisible();
});

test("narrow viewports stack the panels and hide the divider", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 720 });
  await expect(divider(page)).toBeHidden();
  await expect(page.getByRole("tree", { name: "文件树" })).toBeVisible();
  await expect(page.getByRole("region", { name: "文件编辑器" })).toBeHidden();
  await expect(page.getByLabel("工作区状态栏")).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(360);
});
