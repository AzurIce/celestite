import { expect, type Page } from "@playwright/test";

export type EditorModeLabel = "源码" | "实时渲染" | "分栏" | "预览";

/** Follow the same mode menu on desktop and the compact document menu on mobile. */
export async function chooseEditorMode(page: Page, name: EditorModeLabel) {
  const trigger = page.getByRole("button", { name: "编辑器视图", exact: true });
  if ((page.viewportSize()?.width ?? 1280) > 700) await trigger.click();
  else
    await page.getByRole("button", { name: "文档选项", exact: true }).click();
  await page.getByRole("menuitemradio", { name, exact: true }).click();
  await editorMenuClosed(
    page,
    (page.viewportSize()?.width ?? 1280) > 700 ? "编辑器视图" : "文档选项",
  );
}

export async function openDocumentOptions(page: Page) {
  await page.getByRole("button", { name: "文档选项", exact: true }).click();
}

export async function previewAction(
  page: Page,
  name: "刷新预览" | "授权依赖目录",
) {
  await openDocumentOptions(page);
  await page.getByRole("menuitem", { name, exact: true }).click();
  await editorMenuClosed(page);
}

export async function fileAction(page: Page, name: string) {
  await page.getByRole("button", { name: "文件操作", exact: true }).click();
  await page.getByRole("menuitem", { name, exact: true }).click();
}

export async function expectEditorMode(page: Page, name: EditorModeLabel) {
  const trigger = page.getByRole("button", { name: "编辑器视图", exact: true });
  if ((page.viewportSize()?.width ?? 1280) > 700) await trigger.click();
  else
    await page.getByRole("button", { name: "文档选项", exact: true }).click();
  await expect(
    page.getByRole("menuitemradio", { name, exact: true }),
  ).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");
  await editorMenuClosed(
    page,
    (page.viewportSize()?.width ?? 1280) > 700 ? "编辑器视图" : "文档选项",
  );
}

/** Kobalte closes selection menus asynchronously and then restores their trigger. */
export async function editorMenuClosed(page: Page, triggerName = "文档选项") {
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: triggerName, exact: true }),
  ).toBeFocused();
}
