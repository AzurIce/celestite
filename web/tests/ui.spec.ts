import { expect, test as base } from "@playwright/test";

const test = base.extend<{ runtimeErrors: string[] }>({
  runtimeErrors: [async ({ page }, use) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    await use(errors);
    expect(errors).toEqual([]);
  }, { auto: true }],
});

test.beforeEach(async ({ page }) => {
  await page.goto("/ui");
  await expect(page.getByRole("heading", { name: "Celestite" })).toBeVisible();
});

test("controlled input, dialog focus, dismissal and repeated portal cleanup", async ({ page }) => {
  const input = page.getByRole("textbox", { name: "笔记名称" });
  await input.fill("");
  await input.pressSequentially("Solid 2");
  await expect(input).toHaveValue("Solid 2");
  await expect(input).toHaveAttribute("aria-describedby", /textfield/);

  const trigger = page.getByRole("button", { name: "打开弹窗" });
  const dialog = page.getByRole("dialog", { name: "笔记信息" });
  for (const close of ["escape", "button", "outside"] as const) {
    await trigger.click();
    await expect(dialog).toContainText("Solid 2");
    await expect(dialog.getByRole("button", { name: "Dismiss" })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(dialog.getByRole("button", { name: "关闭弹窗" })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(dialog.getByRole("button", { name: "Dismiss" })).toBeFocused();
    if (close === "escape") await page.keyboard.press("Escape");
    else if (close === "button") await dialog.getByRole("button", { name: "关闭弹窗" }).click();
    else await page.locator(".ui-dialog-overlay").click({ position: { x: 5, y: 5 } });
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
    await expect(page.locator("body")).not.toHaveCSS("pointer-events", "none");
  }
});

test("dropdown keyboard navigation, selection and Escape", async ({ page }) => {
  const trigger = page.getByRole("button", { name: "笔记操作" });
  await trigger.focus();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("menuitem", { name: "重命名" })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("status")).toHaveText("点击了复制链接");
  await expect(page.getByRole("menu")).toBeHidden();
  await trigger.click();
  await expect(page.getByRole("menuitem", { name: "导出（暂不可用）" })).toHaveAttribute("aria-disabled", "true");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toBeHidden();
  await expect(trigger).toBeFocused();
});

test("context menu supports pointer and keyboard access", async ({ page }) => {
  const trigger = page.getByLabel("笔记，右键或按 Shift+F10 打开操作菜单");
  await trigger.click({ button: "right" });
  await page.getByRole("menuitem", { name: "打开笔记", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("点击了打开笔记");
  await expect(page.getByRole("menu")).toBeHidden();
  await trigger.focus();
  await page.keyboard.press("Shift+F10");
  await expect(page.getByRole("menuitem", { name: "打开笔记", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toBeHidden();
});

test("theme commits immediately, persists, follows system and reaches portals", async ({ page }) => {
  const selectTheme = async (name: string) => {
    await page.getByRole("button", { name: "主题", exact: true }).click();
    await page.getByRole("menuitem", { name, exact: true }).click();
  };
  await selectTheme("深色");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByRole("button", { name: "打开弹窗" }).click();
  const surface = await page.locator("section").evaluate((el) => getComputedStyle(el).backgroundColor);
  await expect(page.getByRole("dialog")).toHaveCSS("background-color", surface);
  await page.keyboard.press("Escape");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await selectTheme("浅色");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await selectTheme("跟随系统");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
});

test("SVG icons, disabled buttons, tooltip and theme dimensions", async ({ page }) => {
  const button = page.getByRole("button", { name: "新建笔记", exact: true });
  await expect(button).toHaveCSS("height", "32px");
  await expect(button.locator("svg")).toHaveAttribute("width", "16");
  expect(await button.locator("svg path").first().evaluate((el) => el.namespaceURI)).toBe("http://www.w3.org/2000/svg");
  await expect(page.getByRole("button", { name: "不可用" })).toBeDisabled();
  await button.click();
  await expect(page.getByRole("status")).toHaveText("点击了新建笔记");
  await page.getByRole("button", { name: "添加笔记" }).hover();
  await expect(page.getByRole("tooltip")).toHaveText("添加笔记");
});

test("mobile preview fits viewport and home remains empty", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 720 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
  await page.goto("/");
  await expect(page.locator("main")).toBeEmpty();
});
