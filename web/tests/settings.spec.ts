import { expect, test as base } from "@playwright/test";

const test = base.extend<{ runtimeErrors: string[] }>({
  runtimeErrors: [
    async ({ page }, use) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error") errors.push(message.text());
      });
      await use(errors);
      expect(errors).toEqual([]);
    },
    { auto: true },
  ],
});

const projectSettings = ".celestite/settings.json";

type VaultModule = typeof import("../src/lib/vault");

/** 全局设置文件内容；文件不存在返回 null。 */
function readAppSettings(page: import("@playwright/test").Page) {
  return page.evaluate(async () => {
    try {
      const root = await navigator.storage.getDirectory();
      const directory = await root.getDirectoryHandle("celestite");
      const file = await directory.getFileHandle("settings.json");
      return await (await file.getFile()).text();
    } catch {
      return null;
    }
  });
}

/** 项目级设置文件内容；文件不存在返回 null。 */
function readProjectSettings(page: import("@playwright/test").Page) {
  return page.evaluate(async (path: string) => {
    const url = "/src/lib/vault/index.ts";
    const { openOpfsVault } = (await import(url)) as VaultModule;
    const backend = await openOpfsVault();
    try {
      if ((await backend.stat(path as never)) === null) return null;
      return new TextDecoder().decode(await backend.readFile(path as never));
    } catch {
      return null;
    } finally {
      await backend.close();
    }
  }, projectSettings);
}

async function seedProjectSettings(
  page: import("@playwright/test").Page,
  document: unknown,
) {
  await page.evaluate(
    async ({ path, text }) => {
      const url = "/src/lib/vault/index.ts";
      const { openOpfsVault } = (await import(url)) as VaultModule;
      const backend = await openOpfsVault();
      await backend.mkdir(".celestite" as never, { recursive: true });
      await backend.writeFile(path as never, new TextEncoder().encode(text), {
        mode: "create",
      });
      await backend.close();
    },
    { path: projectSettings, text: JSON.stringify(document) },
  );
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.evaluate(async () => {
    const url = "/src/lib/vault/index.ts";
    const { openOpfsVault, vaultPath } = (await import(url)) as VaultModule;
    const backend = await openOpfsVault();
    await backend.writeFile(
      vaultPath("a.md"),
      new TextEncoder().encode("# a\n"),
      { mode: "create" },
    );
    await backend.close();
  });
  await page.goto("/");
  await expect(page.getByRole("tree", { name: "文件树" })).toHaveAttribute(
    "aria-busy",
    "false",
  );
});

test("theme selection persists to the app settings file", async ({ page }) => {
  await page.getByRole("button", { name: "主题", exact: true }).click();
  await page.getByRole("menuitem", { name: "深色", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect
    .poll(() => readAppSettings(page))
    .toContain('"theme.mode": "dark"');
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.getByRole("tree", { name: "文件树" })).toBeVisible();
});

test("legacy localStorage keys migrate once into the settings file", async ({
  page,
}) => {
  await page.evaluate(() => {
    localStorage.setItem("celestite.theme", "dark");
    localStorage.setItem("celestite.workspace.sidebarWidth", "420");
  });
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator(".workspace-sidebar")).toHaveCSS("width", "420px");
  await expect
    .poll(() => readAppSettings(page))
    .toContain('"sidebar.width": 42');
  const left = await page.evaluate(() => ({
    theme: localStorage.getItem("celestite.theme"),
    width: localStorage.getItem("celestite.workspace.sidebarWidth"),
  }));
  expect(left).toEqual({ theme: null, width: null });
});

test("project settings override the app file for the keys they set", async ({
  page,
}) => {
  await seedProjectSettings(page, { "editor.wordWrap": true });
  await page.reload();
  await expect(page.getByRole("tree", { name: "文件树" })).toHaveAttribute(
    "aria-busy",
    "false",
  );
  await page.getByRole("treeitem", { name: "a.md", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "自动换行", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".cm-content")).toHaveClass(/cm-lineWrapping/);
});

test("project settings can narrow the sidebar below the app default", async ({
  page,
}) => {
  await page.getByRole("button", { name: "主题", exact: true }).click();
  await page.getByRole("menuitem", { name: "深色", exact: true }).click();
  await expect.poll(() => readAppSettings(page)).toContain('"theme.mode"');
  await seedProjectSettings(page, {
    "sidebar.width": 200,
    "theme.mode": "light",
  });
  await page.reload();
  await expect(page.locator(".workspace-sidebar")).toHaveCSS("width", "200px");
  // 主题被项目级覆盖成浅色，即使全局文件里是深色。
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
});

test("the app never writes the project settings file", async ({ page }) => {
  await seedProjectSettings(page, { "editor.wordWrap": true });
  await page.reload();
  await page.getByRole("treeitem", { name: "a.md", exact: true }).click();
  const wrap = page.getByRole("button", { name: "自动换行", exact: true });
  // 项目级提供的值只读：界面显示生效值，但不允许在全局层改写。
  await expect(wrap).toHaveAttribute("aria-pressed", "true");
  await expect(wrap).toBeDisabled();
  await expect(page.locator(".cm-content")).toHaveClass(/cm-lineWrapping/);
  await page.getByRole("button", { name: "主题", exact: true }).click();
  await page.getByRole("menuitem", { name: "深色", exact: true }).click();
  await expect
    .poll(() => readAppSettings(page))
    .toContain('"theme.mode": "dark"');
  // 全局写入只碰全局文件，项目文件保持原样。
  expect(await readProjectSettings(page)).toBe(
    JSON.stringify({ "editor.wordWrap": true }),
  );
});

test("a broken project file falls back instead of blocking startup", async ({
  page,
}) => {
  await page.getByRole("button", { name: "主题", exact: true }).click();
  await page.getByRole("menuitem", { name: "深色", exact: true }).click();
  await expect
    .poll(() => readAppSettings(page))
    .toContain('"theme.mode": "dark"');
  await seedProjectSettings(page, {
    "theme.mode": "banana",
    "sidebar.width": "x",
  });
  await page.reload();
  await expect(page.getByRole("tree", { name: "文件树" })).toHaveAttribute(
    "aria-busy",
    "false",
  );
  // 坏值回退到全局文件，应用照常工作。
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator(".workspace-sidebar")).toHaveCSS("width", "300px");
  await page.getByRole("treeitem", { name: "a.md", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "代码编辑器" })).toBeVisible();
});
