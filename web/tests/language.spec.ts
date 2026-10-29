import { expect, test } from "@playwright/test";
import { installWorkerHarness } from "./worker-harness";
import { chooseEditorMode } from "./editor-actions";
import type { EditorView } from "@codemirror/view";

const valid = "fn ok(value: String) -> BlockContent;";

test.beforeEach(async ({ page }) => {
  await installWorkerHarness(page);
  await page.goto("/");
  await page.evaluate(async () => {
    const { openOpfsVault, vaultPath } = await import(
      "/src/lib/vault/index.ts" as string
    );
    const vault = await openOpfsVault();
    await vault.writeFile(
      vaultPath("broken.notc"),
      new TextEncoder().encode("fn broken("),
      { mode: "create" },
    );
    await vault.writeFile(
      vaultPath("plain.txt"),
      new TextEncoder().encode("fn broken("),
      { mode: "create" },
    );
    await vault.writeFile(
      vaultPath("note.not"),
      new TextEncoder().encode('= 标题\n\n正文 #badge(label: "hi") 结束\n'),
      { mode: "create" },
    );
    for (const [path, content] of [
      ["target.not", "= 目标文档\n"],
      ["lib.notc", "fn original() -> BlockContent;"],
      ["outline.md", "# 总览\n\n## 第一节\n\n正文\n\n## 第二节\n\n末尾\n"],
    ])
      await vault.writeFile(
        vaultPath(path),
        new TextEncoder().encode(content),
        { mode: "create" },
      );
    await vault.close();
  });
  await page.reload();
});

test("notist diagnostics underline broken code and clear after a fix", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page
    .getByRole("treeitem", { name: "broken.notc", exact: true })
    .click();
  const editor = page.getByRole("textbox", { name: "代码编辑器" });
  // Zero-length diagnostics render as zero-width point widgets, ranged ones as
  // underlines; assert DOM attachment, not visibility.
  const markers = editor.locator(".cm-lintRange-error, .cm-lintPoint-error");
  // The language worker round trip (wasm init, initialize, refresh) can take
  // a moment on a cold start; give it room.
  await expect(markers.first()).toBeAttached({ timeout: 15000 });
  await editor.fill(valid);
  await expect(editor.locator(".cm-lintRange, .cm-lintPoint")).toHaveCount(0, {
    timeout: 15000,
  });
  // Files without a language binding never subscribe to diagnostics.
  await page.getByRole("treeitem", { name: "plain.txt", exact: true }).click();
  await page.waitForTimeout(1000);
  await expect(page.locator(".cm-content .cm-lintRange")).toHaveCount(0);
  await expect(page.locator(".cm-content .cm-lintPoint")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("hover over markup shows the language service tooltip", async ({
  page,
}) => {
  await page.getByRole("treeitem", { name: "note.not", exact: true }).click();
  const editor = page.getByRole("textbox", { name: "代码编辑器" });
  const call = editor.locator('[data-syntax="function.call"]').first();
  await expect(call).toHaveText("badge");
  await call.hover();
  // The hover request shares the verified message path; the tooltip renders
  // the ctor info returned by the service.
  await expect(page.locator(".cm-tooltip").first()).toBeVisible({
    timeout: 15000,
  });
  await expect(page.locator(".cm-tooltip").first()).toContainText("badge");
});

test("F12 opens the definition in another vault document", async ({ page }) => {
  await page.getByRole("treeitem", { name: "note.not", exact: true }).click();
  const editor = page.getByRole("textbox", { name: "代码编辑器" });
  await editor.fill("[跳转](target.not)");
  await editor.press("End");
  await editor.press("ArrowLeft");
  await editor.press("ArrowLeft");
  await editor.press("F12");
  await expect(
    page.getByRole("tab", { name: "target.not", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(editor).toContainText("目标文档");
  await expect(editor).toBeFocused();
});

test("inactive unsaved declarations remain available for diagnostics and definitions", async ({
  page,
}) => {
  // Hold autosave in the real editor worker so this checks an in-memory source.
  const { workerEvaluate } = await import("./worker-harness");
  await expect(
    page.getByRole("treeitem", { name: "lib.notc", exact: true }),
  ).toBeVisible();
  await workerEvaluate(page, () => {
    const native = self.setTimeout;
    self.setTimeout = ((
      callback: TimerHandler,
      delay?: number,
      ...args: unknown[]
    ) =>
      native(
        callback,
        delay && delay >= 500 && delay < 10000 ? 60000 : delay,
        ...args,
      )) as typeof setTimeout;
  });
  await page.getByRole("treeitem", { name: "lib.notc", exact: true }).click();
  const editor = page.getByRole("textbox", { name: "代码编辑器" });
  await editor.fill("fn changed() -> BlockContent;");
  await page.getByRole("treeitem", { name: "note.not", exact: true }).click();
  await editor.fill('#import "./lib.notc" as demo;\n\n#demo.changed()');
  await editor.press("End");
  await editor.press("ArrowLeft");
  await editor.press("ArrowLeft");
  await editor.press("ArrowLeft");
  await editor.press("F12");
  await expect(
    page.getByRole("tab", { name: "lib.notc", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(editor).toHaveText("fn changed() -> BlockContent;");
  const disk = await page.evaluate(async () => {
    const { openOpfsVault, vaultPath } = await import(
      "/src/lib/vault/index.ts" as string
    );
    const vault = await openOpfsVault();
    try {
      return new TextDecoder().decode(
        await vault.readFile(vaultPath("lib.notc")),
      );
    } finally {
      await vault.close();
    }
  });
  expect(disk).toBe("fn original() -> BlockContent;");
});

test("the document outline keeps the editor mounted, navigates headings and restores keyboard focus", async ({
  page,
}) => {
  await page.getByRole("treeitem", { name: "outline.md", exact: true }).click();
  const editor = page.getByRole("textbox", { name: "代码编辑器" });
  await expect(editor).toContainText("第二节");
  const originalView = await editor.evaluateHandle(
    (element) =>
      (element as HTMLElement & { cmTile: { root: { view: EditorView } } })
        .cmTile.root.view,
  );
  const trigger = page.getByRole("button", { name: "文档大纲", exact: true });
  await trigger.click();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  const outline = page.getByRole("complementary", {
    name: "文档大纲",
    exact: true,
  });
  const target = outline.getByRole("button", { name: "第二节", exact: true });
  await expect(target).toBeVisible();
  await target.click();
  await expect(outline).toBeVisible();
  await expect(editor).toBeFocused();
  expect(
    await page.evaluate(() => window.getSelection()?.toString()),
  ).toContain("第二节");
  expect(
    await editor.evaluate(
      (element, original) =>
        (element as HTMLElement & { cmTile: { root: { view: EditorView } } })
          .cmTile.root.view === original,
      originalView,
    ),
  ).toBe(true);
  await outline
    .getByRole("button", { name: "收起文档大纲", exact: true })
    .focus();
  await page.keyboard.press("Escape");
  await expect(outline).toBeHidden();
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(trigger).toBeFocused();
  expect(
    await editor.evaluate(
      (element, original) =>
        (element as HTMLElement & { cmTile: { root: { view: EditorView } } })
          .cmTile.root.view === original,
      originalView,
    ),
  ).toBe(true);
  await originalView.dispose();
});

test("the outline refreshes edited headings and never reuses another document's locations", async ({
  page,
}) => {
  await page.getByRole("treeitem", { name: "outline.md", exact: true }).click();
  const editor = page.getByRole("textbox", { name: "代码编辑器" });
  await page.getByRole("button", { name: "文档大纲", exact: true }).click();
  const outline = page.getByRole("complementary", {
    name: "文档大纲",
    exact: true,
  });
  await expect(
    outline.getByRole("button", { name: "第二节", exact: true }),
  ).toBeVisible();
  const updated = "# 修改后的总览\n\n正文\n\n## 新的第二节\n\n结尾";
  await editor.fill(updated);
  await expect(
    outline.getByRole("button", { name: "第二节", exact: true }),
  ).toHaveCount(0);
  await expect(
    outline.getByRole("button", { name: "新的第二节", exact: true }),
  ).toBeVisible();
  const editedHeading = outline.getByRole("button", {
    name: "新的第二节",
    exact: true,
  });
  await editedHeading.focus();
  await page.keyboard.press("Control+s");
  await expect(
    page.getByRole("status", { name: "保存状态", exact: true }),
  ).toHaveText("已保存");
  await expect(editedHeading).toBeFocused();
  await chooseEditorMode(page, "预览");
  await expect(editor).toBeHidden();
  await outline
    .getByRole("button", { name: "新的第二节", exact: true })
    .click();
  await expect(page.locator(".editor-layout")).toHaveAttribute(
    "data-mode",
    "preview",
  );
  await expect(editor).toBeHidden();
  await chooseEditorMode(page, "源码");
  await editedHeading.click();
  await expect(editor).toBeFocused();
  // The LSP selectionRange covers the raw heading, including its markup.
  const heading = "## 新的第二节";
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(
    heading,
  );
  expect(
    await editor.evaluate((element) => {
      const selection = (
        element as HTMLElement & { cmTile: { root: { view: EditorView } } }
      ).cmTile.root.view.state.selection.main;
      return { from: selection.from, to: selection.to };
    }),
  ).toEqual({
    from: updated.indexOf(heading),
    to: updated.indexOf(heading) + heading.length,
  });
  await page.getByRole("treeitem", { name: "target.not", exact: true }).click();
  await expect(
    outline.getByRole("button", { name: "新的第二节", exact: true }),
  ).toHaveCount(0);
  const target = outline.getByRole("button", { name: "目标文档", exact: true });
  await expect(target).toBeVisible();
  await target.click();
  await expect(editor).toBeFocused();
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(
    "= 目标文档",
  );
  expect(
    await editor.evaluate((element) => {
      const selection = (
        element as HTMLElement & { cmTile: { root: { view: EditorView } } }
      ).cmTile.root.view.state.selection.main;
      return { from: selection.from, to: selection.to };
    }),
  ).toEqual({ from: 0, to: "= 目标文档".length });
});
