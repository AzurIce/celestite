import { expect, test as base, type Page } from "@playwright/test";
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

async function seed(
  page: Page,
  app: Record<string, unknown> = {},
  project?: Record<string, unknown>,
) {
  await page.goto("/");
  await expect(page.getByLabel("工作区状态栏")).toBeVisible();
  await page.evaluate(
    async ({ app, project }) => {
      const root = await navigator.storage.getDirectory();
      const directory = await root.getDirectoryHandle("celestite", {
        create: true,
      });
      const file = await directory.getFileHandle("settings.json", {
        create: true,
      });
      const writable = await file.createWritable();
      await writable.write(JSON.stringify(app));
      await writable.close();
      const url = "/src/lib/vault/index.ts";
      const { openOpfsVault, vaultPath } = (await import(url)) as VaultModule;
      const vault = await openOpfsVault();
      await vault.writeFile(
        vaultPath("a.md"),
        new TextEncoder().encode("# Settings test\n"),
        { mode: "create" },
      );
      if (project) {
        await vault.mkdir(vaultPath(".celestite"));
        await vault.writeFile(
          vaultPath(".celestite/settings.json"),
          new TextEncoder().encode(JSON.stringify(project)),
          { mode: "create" },
        );
      }
      await vault.close();
    },
    { app, project },
  );
  await page.goto("/");
  await expect(page.getByRole("tree", { name: "文件树" })).toHaveAttribute(
    "aria-busy",
    "false",
  );
}

async function readApp(page: Page) {
  return page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const directory = await root.getDirectoryHandle("celestite");
    const file = await directory.getFileHandle("settings.json");
    return JSON.parse(await (await file.getFile()).text());
  });
}

async function open(page: Page) {
  await page.getByRole("button", { name: "全局设置", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "全局设置", exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}

test("global controls update the workspace, preserve unknown preferences and survive reload", async ({
  page,
}) => {
  await seed(page, { "future.preference": { keep: true } });
  const dialog = await open(page);
  await expect(
    dialog.getByRole("combobox", { name: "主题", exact: true }),
  ).toHaveValue("system");
  await expect(
    dialog.getByRole("spinbutton", { name: "侧栏宽度", exact: true }),
  ).toHaveValue("300");
  await dialog
    .getByRole("combobox", { name: "主题", exact: true })
    .selectOption("dark");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await dialog.getByRole("checkbox", { name: "自动换行", exact: true }).check();
  const width = dialog.getByRole("spinbutton", {
    name: "侧栏宽度",
    exact: true,
  });
  await width.fill("420");
  await width.press("Enter");
  await expect(page.locator(".workspace-sidebar")).toHaveCSS("width", "420px");
  await expect(dialog.getByRole("status", { name: "设置保存状态" })).toHaveText(
    "已保存",
  );
  expect(await readApp(page)).toEqual({
    "future.preference": { keep: true },
    "theme.mode": "dark",
    "sidebar.width": 420,
    "editor.wordWrap": true,
  });
  await dialog.getByRole("button", { name: "关闭弹窗" }).click();
  await expect(
    page.getByRole("button", { name: "全局设置", exact: true }),
  ).toBeFocused();
  await page.getByRole("separator", { name: "调整侧边栏宽度" }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.locator(".workspace-sidebar")).toHaveCSS("width", "436px");
  await expect
    .poll(async () => (await readApp(page))["sidebar.width"])
    .toBe(436);
  await page.getByRole("treeitem", { name: "a.md", exact: true }).click();
  await expect(page.locator(".cm-content")).toHaveClass(/cm-lineWrapping/);
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  const reopened = await open(page);
  await expect(
    reopened.getByRole("spinbutton", { name: "侧栏宽度", exact: true }),
  ).toHaveValue("436");
  await expect(
    reopened.getByRole("checkbox", { name: "自动换行", exact: true }),
  ).toBeChecked();
});

test("invalid widths do not save, and each control can restore its default", async ({
  page,
}) => {
  await seed(page);
  const dialog = await open(page);
  const width = dialog.getByRole("spinbutton", {
    name: "侧栏宽度",
    exact: true,
  });
  await width.fill("100");
  await width.press("Enter");
  await expect(width).toHaveAttribute("aria-invalid", "true");
  await expect(dialog.getByRole("alert")).toContainText("200 至 560");
  expect(await readApp(page)).toEqual({});
  await dialog
    .getByRole("button", { name: "恢复默认侧栏宽度", exact: true })
    .click();
  await expect(width).toHaveValue("300");
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await width.fill("460");
  await width.press("Enter");
  await expect(page.locator(".workspace-sidebar")).toHaveCSS("width", "460px");
  await dialog
    .getByRole("button", { name: "恢复默认侧栏宽度", exact: true })
    .click();
  await expect(page.locator(".workspace-sidebar")).toHaveCSS("width", "300px");
  await dialog
    .getByRole("combobox", { name: "主题", exact: true })
    .selectOption("dark");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await dialog
    .getByRole("button", { name: "恢复默认主题", exact: true })
    .click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await dialog.getByRole("checkbox", { name: "自动换行", exact: true }).check();
  await dialog
    .getByRole("button", { name: "恢复默认自动换行", exact: true })
    .click();
  await expect(
    dialog.getByRole("checkbox", { name: "自动换行", exact: true }),
  ).not.toBeChecked();
  await expect(dialog.getByRole("status", { name: "设置保存状态" })).toHaveText(
    "已保存",
  );
  expect(await readApp(page)).toEqual({
    "sidebar.width": 300,
    "theme.mode": "system",
    "editor.wordWrap": false,
  });
});

test("global values remain editable when a Vault overrides them, and project bytes stay unchanged", async ({
  page,
}) => {
  const project = {
    "theme.mode": "light",
    "sidebar.width": 200,
    "editor.wordWrap": true,
  };
  await seed(
    page,
    { "theme.mode": "dark", "sidebar.width": 420, "editor.wordWrap": false },
    project,
  );
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page.locator(".workspace-sidebar")).toHaveCSS("width", "200px");
  const dialog = await open(page);
  await expect(
    dialog.getByRole("combobox", { name: "主题", exact: true }),
  ).toHaveValue("dark");
  await expect(
    dialog.getByRole("spinbutton", { name: "侧栏宽度", exact: true }),
  ).toHaveValue("420");
  await expect(
    dialog.getByRole("checkbox", { name: "自动换行", exact: true }),
  ).not.toBeChecked();
  await expect(dialog.locator(".settings-override")).toHaveCount(3);
  await dialog
    .getByRole("combobox", { name: "主题", exact: true })
    .selectOption("system");
  await dialog
    .getByRole("spinbutton", { name: "侧栏宽度", exact: true })
    .fill("500");
  await dialog
    .getByRole("spinbutton", { name: "侧栏宽度", exact: true })
    .press("Enter");
  await expect(dialog.getByRole("status", { name: "设置保存状态" })).toHaveText(
    "已保存",
  );
  await expect(page.locator(".workspace-sidebar")).toHaveCSS("width", "200px");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  expect((await readApp(page))["sidebar.width"]).toBe(500);
  const text = await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const vaults = await root.getDirectoryHandle("vaults");
    const vault = await vaults.getDirectoryHandle("default");
    const directory = await vault.getDirectoryHandle(".celestite");
    const file = await directory.getFileHandle("settings.json");
    return await (await file.getFile()).text();
  });
  expect(text).toBe(JSON.stringify(project));
});

test("save errors keep the draft and retry writes it to the app file", async ({
  page,
}) => {
  await seed(page, { "theme.mode": "light" });
  const dialog = await open(page);
  await page.evaluate(() => {
    const original = FileSystemFileHandle.prototype.createWritable;
    (window as unknown as { restoreWriter: () => void }).restoreWriter = () => {
      FileSystemFileHandle.prototype.createWritable = original;
    };
    FileSystemFileHandle.prototype.createWritable = async function (options) {
      if (this.name === "settings.json")
        throw new DOMException("Injected quota failure", "QuotaExceededError");
      return original.call(this, options);
    };
  });
  try {
    await dialog
      .getByRole("combobox", { name: "主题", exact: true })
      .selectOption("dark");
    await expect(
      dialog.getByRole("status", { name: "设置保存状态" }),
    ).toHaveText("保存失败");
    await expect(dialog.getByRole("alert")).toContainText("修改仍保留");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    expect((await readApp(page))["theme.mode"]).toBe("light");
    await page.evaluate(() =>
      (window as unknown as { restoreWriter: () => void }).restoreWriter(),
    );
    await dialog.getByRole("button", { name: "重试保存", exact: true }).click();
    await expect(
      dialog.getByRole("status", { name: "设置保存状态" }),
    ).toHaveText("已保存");
    await expect(dialog.getByRole("alert")).toHaveCount(0);
    expect((await readApp(page))["theme.mode"]).toBe("dark");
  } finally {
    await page.evaluate(() =>
      (window as unknown as { restoreWriter: () => void }).restoreWriter(),
    );
  }
});

test("invalid global settings are described and fixing them clears the notice", async ({
  page,
}) => {
  await seed(page, { "theme.mode": "unknown", "future.option": true });
  const dialog = await open(page);
  await expect(
    dialog.getByText("部分全局设置无效", { exact: false }),
  ).toBeVisible();
  await dialog
    .getByRole("combobox", { name: "主题", exact: true })
    .selectOption("light");
  await expect(
    dialog.getByText("部分全局设置无效", { exact: false }),
  ).toHaveCount(0);
  await expect(dialog.getByRole("status", { name: "设置保存状态" })).toHaveText(
    "已保存",
  );
  expect(await readApp(page)).toEqual({
    "theme.mode": "light",
    "future.option": true,
  });
});

test("mobile settings fit the viewport and Escape restores focus", async ({
  page,
}) => {
  await seed(page);
  await page.setViewportSize({ width: 360, height: 640 });
  const dialog = await open(page);
  const box = (await dialog.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(16);
  expect(box.x + box.width).toBeLessThanOrEqual(344);
  expect(box.y).toBeGreaterThanOrEqual(16);
  expect(box.y + box.height).toBeLessThanOrEqual(624);
  expect(
    await dialog.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBe(true);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(
    page.getByRole("button", { name: "全局设置", exact: true }),
  ).toBeFocused();
});

test("a session-only settings backend does not claim the preferences are saved", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.getPrototypeOf(navigator.storage).getDirectory = async () => {
      throw new DOMException("Disabled storage", "SecurityError");
    };
  });
  await page.goto("/");
  const dialog = await open(page);
  await expect(dialog.getByRole("status", { name: "设置保存状态" })).toHaveText(
    "仅保留在本次会话",
  );
  await dialog
    .getByRole("combobox", { name: "主题", exact: true })
    .selectOption("dark");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(dialog.getByRole("status", { name: "设置保存状态" })).toHaveText(
    "仅保留在本次会话",
  );
});
