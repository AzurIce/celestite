import {
  expect,
  test as base,
  type Locator,
  type Page,
} from "@playwright/test";
import type { EditorView } from "@codemirror/view";
import { installWorkerHarness } from "./worker-harness";
import {
  chooseEditorMode,
  editorMenuClosed,
  expectEditorMode,
  openDocumentOptions,
} from "./editor-actions";

type VaultModule = typeof import("../src/lib/vault");
const markdown =
  "# 标题 😀\n\n**粗体** 与 *斜体* 和 `x < y` [链接](target.md)\n\n> 引用文字\n\n尾段落";
const notist =
  "= 标题 😀\n\n*粗体* 与 _斜体_ 和 `x < y` [链接](target.md)\n\n#unknown[原样保留]\n\n尾段落";
const rawMarkdown =
  "# 外部标题\n\n```md\n# 代码标题\n**代码粗体** [literal](target.md)\n```\n\n行内 `**code bold**`\n\n尾段落";
const rawNotist =
  '= 外部标题\n\n```not\n= 代码标题\n*代码粗体* [literal](target.md)\n```\n\n#call(value: "*参数字符串*")\n\n尾段落';
const spaced = "第一段\n\n\n第二段\n\n多行标题\n仍是标题\n========\n\n尾段";
const table =
  "| 名称 | 数量 | 备注 |\n| :--- | :---: | ---: |\n| 苹果 | 3 | 红色 |\n| 香蕉 |  | 黄色 |\n\n尾段落";
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
const editor = (page: Page) =>
  page.getByRole("textbox", { name: "代码编辑器" });
function source(page: Page) {
  return editor(page).evaluate((element) =>
    (
      element as HTMLElement & { cmTile: { root: { view: EditorView } } }
    ).cmTile.root.view.state.doc.toString(),
  );
}
function select(page: Page, from: number, to = from) {
  return editor(page).evaluate(
    (element, { from, to }) => {
      const view = (
        element as HTMLElement & { cmTile: { root: { view: EditorView } } }
      ).cmTile.root.view;
      view.dispatch({ selection: { anchor: from, head: to } });
    },
    { from, to },
  );
}
function typographySample(
  root: Locator,
  targets: { name: string; selector: string; text: string }[],
) {
  return root.evaluate((root, targets) => {
    const samples = targets.map(({ name, selector, text }) => {
      const element = [...root.querySelectorAll<HTMLElement>(selector)].find(
        (element) => element.textContent?.includes(text),
      );
      if (!element) throw new Error(`Missing ${name}: ${selector} / ${text}`);
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      const nodes: Text[] = [];
      while (walker.nextNode()) nodes.push(walker.currentNode as Text);
      const start = nodes
        .map((node) => node.data)
        .join("")
        .indexOf(text);
      if (start < 0) throw new Error(`Missing visible text for ${name}`);
      const end = start + text.length;
      const range = document.createRange();
      const styles: {
        fontFamily: string;
        fontSize: number;
        fontWeight: string;
        fontStyle: string;
        lineHeight: number;
        color: string;
      }[] = [];
      let offset = 0;
      for (const node of nodes) {
        const next = offset + node.length;
        if (next > start && offset < end) {
          if (offset <= start) range.setStart(node, start - offset);
          if (next >= end) range.setEnd(node, end - offset);
          const style = getComputedStyle(node.parentElement!);
          styles.push({
            fontFamily: style.fontFamily,
            fontSize: parseFloat(style.fontSize),
            fontWeight: style.fontWeight,
            fontStyle: style.fontStyle,
            lineHeight: parseFloat(style.lineHeight),
            color: style.color,
          });
        }
        offset = next;
      }
      const rects = [...range.getClientRects()].filter(
        (rect) => rect.width > 0,
      );
      const bounds = range.getBoundingClientRect();
      const box = element.getBoundingClientRect();
      const css = getComputedStyle(element);
      const rows: number[] = [];
      for (const rect of rects.sort((a, b) => a.top - b.top))
        if (!rows.some((top) => Math.abs(top - rect.top) < 6))
          rows.push(rect.top);
      const tree = element.getRootNode();
      const pane =
        element.closest(".preview-scroller, .cm-scroller") ??
        (tree instanceof ShadowRoot
          ? tree.host.closest(".preview-scroller")
          : null);
      if (!pane) throw new Error(`Missing scroll pane for ${name}`);
      const paneBox = pane.getBoundingClientRect();
      return [
        name,
        {
          styles: [
            ...new Map(
              styles.map((style) => [JSON.stringify(style), style]),
            ).values(),
          ],
          decoration: {
            background: css.backgroundColor,
            radius: parseFloat(css.borderRadius),
            paddingLeft: parseFloat(css.paddingLeft),
            paddingRight: parseFloat(css.paddingRight),
            paddingTop: parseFloat(css.paddingTop),
            paddingBottom: parseFloat(css.paddingBottom),
            borderLeftWidth: parseFloat(css.borderLeftWidth),
            borderLeftColor: css.borderLeftColor,
            underline: css.textDecorationLine,
            underlineOffset: css.textUnderlineOffset,
          },
          text: {
            top: bounds.top,
            bottom: bounds.bottom,
            left: bounds.left,
            rows: rows.length,
          },
          column: {
            width:
              box.width -
              parseFloat(css.paddingLeft) -
              parseFloat(css.paddingRight) -
              parseFloat(css.borderLeftWidth) -
              parseFloat(css.borderRightWidth),
            center: (box.left + box.right) / 2 - paneBox.left,
            paneWidth: paneBox.width,
            scrollWidth: pane.scrollWidth,
            clientWidth: pane.clientWidth,
          },
        },
      ] as const;
    });
    return Object.fromEntries(samples);
  }, targets);
}
async function readFile(page: Page, path: string) {
  return page.evaluate(async (path) => {
    const { openOpfsVault, vaultPath } = (await import(
      "/src/lib/vault/index.ts" as string
    )) as VaultModule;
    const vault = await openOpfsVault();
    try {
      return new TextDecoder().decode(await vault.readFile(vaultPath(path)));
    } finally {
      await vault.close();
    }
  }, path);
}
async function live(page: Page, name: string, content: string) {
  await page.getByRole("treeitem", { name, exact: true }).click();
  await chooseEditorMode(page, "实时渲染");
  await expect(page.locator('[data-live-preview="true"]')).toHaveCount(1);
  await editor(page).focus();
  await select(page, content.length);
  await expect(page.locator(".cm-live-marker-hidden")).not.toHaveCount(0);
}

test.beforeEach(async ({ page }) => {
  await installWorkerHarness(page);
  await page.goto("/");
  await page.evaluate(
    async ({ markdown, notist, rawMarkdown, rawNotist, spaced, table }) => {
      const { openOpfsVault, vaultPath } = (await import(
        "/src/lib/vault/index.ts" as string
      )) as VaultModule;
      const vault = await openOpfsVault();
      try {
        for (const [path, content] of [
          ["live.md", markdown],
          ["live.not", notist],
          ["raw.md", rawMarkdown],
          ["raw.not", rawNotist],
          ["spaced.md", spaced],
          ["table.md", table],
          ["table.not", table],
          ["ime.md", markdown + "\n\n输入："],
          ["target.md", "# 目标\n"],
          ["plain.ts", 'const literal = "**不是标记**";\n'],
        ])
          await vault.writeFile(
            vaultPath(path),
            new TextEncoder().encode(content),
            { mode: "create" },
          );
      } finally {
        await vault.close();
      }
    },
    { markdown, notist, rawMarkdown, rawNotist, spaced, table },
  );
  await page.reload();
  await expect(
    page.getByRole("treeitem", { name: "live.md", exact: true }),
  ).toBeVisible();
});

for (const file of [
  { path: "live.md", content: markdown, heading: "#", strong: "**粗体**" },
  { path: "live.not", content: notist, heading: "=", strong: "*粗体*" },
]) {
  test(`${file.path} renders semantic ranges and exposes source at the cursor`, async ({
    page,
  }, testInfo) => {
    await live(page, file.path, file.content);
    await expect(page.getByRole("region", { name: "文档预览" })).toHaveCount(0);
    await expect(page.locator(".cm-live-heading").first()).toContainText(
      "标题 😀",
    );
    await expect(
      page.locator('.cm-live-marker-hidden[data-live-kind="heading"]'),
    ).not.toHaveCount(0);
    await expect(page.locator(".cm-live-strong").first()).toHaveText("粗体");
    await expect(page.locator(".cm-live-emphasis").first()).toHaveText("斜体");
    await expect(page.locator(".cm-live-code").first()).toHaveText("x < y");
    await expect(page.locator(".cm-live-link").first()).toHaveText("链接");
    expect(await source(page)).toBe(file.content);
    expect(await readFile(page, file.path)).toBe(file.content);
    const bold = page.locator(".cm-live-strong").first();
    expect(
      Number(
        await bold.evaluate((element) => getComputedStyle(element).fontWeight),
      ),
    ).toBeGreaterThanOrEqual(600);
    await bold.click();
    await expect(editor(page)).toContainText(file.strong);
    await expect(
      page.locator('.cm-live-marker-hidden[data-live-kind="strong"]'),
    ).toHaveCount(0);
    await page.locator(".cm-live-heading").first().click();
    await expect(
      page.locator(".cm-line").filter({ hasText: "标题 😀" }),
    ).toHaveText(`${file.heading} 标题 😀`);
    expect(await source(page)).toBe(file.content);
    if (file.path === "live.md") {
      await select(page, file.content.length);
      await expect(page.locator(".cm-live-quote").first()).toContainText(
        "引用文字",
      );
      await expect(
        page.locator('.cm-live-marker-hidden[data-live-kind="quote"]'),
      ).not.toHaveCount(0);
      await page.screenshot({ path: testInfo.outputPath("live-desktop.png") });
    } else {
      await expect(
        page.locator(".cm-line").filter({ hasText: "原样保留" }),
      ).toHaveText("#unknown[原样保留]");
    }
  });
}

for (const extension of ["md", "not"] as const)
  test(`${extension} live tables align cells, collapse the delimiter row and reveal source in place`, async ({
    page,
  }, testInfo) => {
    const path = `table.${extension}`;
    await page.getByRole("treeitem", { name: path, exact: true }).click();
    await chooseEditorMode(page, "实时渲染");
    await expect(page.locator('[data-live-preview="true"]')).toHaveCount(1);
    await editor(page).focus();
    await select(page, table.length);
    const header = page.locator(".cm-live-table-header");
    await expect(header).toHaveCount(1);
    await expect(header).toContainText("名称");
    await expect(page.locator(".cm-live-table-row")).toHaveCount(2);
    await expect(page.locator(".cm-live-table-cell")).toHaveCount(9);
    const empty = page.locator(".cm-live-table-cell-empty");
    await expect(empty).toHaveCount(1);
    expect((await empty.boundingBox())!.width).toBeGreaterThan(0);
    const delimiter = page.locator(".cm-live-table-delimiter");
    await expect(delimiter).toHaveCount(1);
    expect((await delimiter.boundingBox())!.height).toBeLessThanOrEqual(1.1);
    await expect(
      page.locator('.cm-live-marker-hidden[data-live-kind="table"]'),
    ).not.toHaveCount(0);
    const cells = page.locator(".cm-live-table-cell");
    expect(
      await cells
        .first()
        .evaluate((element) => getComputedStyle(element).display),
    ).toBe("inline-block");
    expect(
      await cells
        .filter({ hasText: "数量" })
        .first()
        .evaluate((element) => getComputedStyle(element).textAlign),
    ).toBe("center");
    expect(
      await cells
        .filter({ hasText: "备注" })
        .first()
        .evaluate((element) => getComputedStyle(element).textAlign),
    ).toBe("right");
    const widths = await page
      .locator(".cm-live-table-row")
      .first()
      .locator(".cm-live-table-cell")
      .evaluateAll((elements) =>
        elements.map((element) => element.getBoundingClientRect().width),
      );
    const contentWidth = await page
      .locator(".cm-live-preview .cm-content")
      .evaluate((element) => {
        const style = getComputedStyle(element);
        return (
          element.getBoundingClientRect().width -
          parseFloat(style.paddingLeft) -
          parseFloat(style.paddingRight)
        );
      });
    expect(
      Math.abs(widths.reduce((sum, width) => sum + width, 0) - contentWidth),
    ).toBeLessThanOrEqual(1.5);
    expect(await source(page)).toBe(table);
    expect(await readFile(page, path)).toBe(table);
    await page.screenshot({ path: testInfo.outputPath(`${path}-table.png`) });

    await cells.first().click();
    await expect(header).toHaveCount(0);
    await expect(
      page.locator(".cm-line").filter({ hasText: "名称" }),
    ).toHaveText("| 名称 | 数量 | 备注 |");
    await expect(
      page.locator(".cm-line").filter({ hasText: "---" }),
    ).toHaveText("| :--- | :---: | ---: |");
    await page.locator(".cm-line").filter({ hasText: "尾段落" }).click();
    await expect(header).toHaveCount(1);
    await expect(page.locator(".cm-live-table-cell")).toHaveCount(9);
    expect(await source(page)).toBe(table);
  });

for (const file of [
  {
    path: "raw.md",
    content: rawMarkdown,
    heading: "# 代码标题",
    literal: "**代码粗体** [literal](target.md)",
  },
  {
    path: "raw.not",
    content: rawNotist,
    heading: "= 代码标题",
    literal: "*代码粗体* [literal](target.md)",
  },
]) {
  test(`${file.path} leaves fenced code and source expressions intact`, async ({
    page,
  }) => {
    await live(page, file.path, file.content);
    await expect(
      page.locator(".cm-line").filter({ hasText: "代码标题" }),
    ).toHaveText(file.heading);
    await expect(
      page.locator(".cm-line").filter({ hasText: "代码粗体" }),
    ).toHaveText(file.literal);
    await expect(page.locator(".cm-live-strong")).toHaveCount(0);
    if (file.path === "raw.md") {
      await expect(page.locator(".cm-live-code").first()).toContainText(
        "**code bold**",
      );
    } else {
      await expect(
        page.locator(".cm-line").filter({ hasText: "参数字符串" }),
      ).toHaveText('#call(value: "*参数字符串*")');
    }
    expect(await source(page)).toBe(file.content);
    expect(await readFile(page, file.path)).toBe(file.content);
  });
}

test("live mode coexists with source, split and preview and persists without changing plain code", async ({
  page,
}, testInfo) => {
  await live(page, "live.md", markdown);
  await page.getByRole("button", { name: "编辑器视图", exact: true }).click();
  for (const label of ["源码", "分栏", "预览", "实时渲染"])
    await expect(
      page.getByRole("menuitemradio", { name: label, exact: true }),
    ).toBeVisible();
  await expect(
    page.getByRole("menuitemradio", { name: "实时渲染", exact: true }),
  ).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");
  await editorMenuClosed(page, "编辑器视图");
  await chooseEditorMode(page, "源码");
  await expect(page.locator('[data-live-preview="true"]')).toHaveCount(0);
  await expect(editor(page)).toContainText("**粗体**");
  await chooseEditorMode(page, "分栏");
  await expect(editor(page)).toBeVisible();
  await expect(page.getByRole("region", { name: "文档预览" })).toBeVisible();
  await chooseEditorMode(page, "预览");
  await expect(editor(page)).toBeHidden();
  await expect(page.getByRole("region", { name: "文档预览" })).toBeVisible();
  await chooseEditorMode(page, "实时渲染");
  await expect(editor(page)).toBeVisible();
  await expect(page.getByRole("region", { name: "文档预览" })).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const root = await navigator.storage.getDirectory();
        const file = await (
          await root.getDirectoryHandle("celestite")
        ).getFileHandle("settings.json");
        try {
          return JSON.parse(await (await file.getFile()).text())[
            "editor.previewMode"
          ];
        } catch (error) {
          // Queued mode writes can replace this immutable File snapshot. The
          // next poll obtains a fresh one; unrelated failures remain visible.
          if (
            error instanceof DOMException &&
            error.name === "NotReadableError"
          )
            return undefined;
          throw error;
        }
      }),
    )
    .toBe("live");
  await page.reload();
  await page.getByRole("treeitem", { name: "live.md", exact: true }).click();
  await expect(page.locator(".editor-layout")).toHaveAttribute(
    "data-mode",
    "live",
  );
  await select(page, markdown.length);
  await expect(page.locator(".cm-live-strong").first()).toHaveText("粗体");
  await page.getByRole("treeitem", { name: "plain.ts", exact: true }).click();
  await expect(page.locator('[data-live-preview="true"]')).toHaveCount(0);
  await expect(editor(page)).toHaveText('const literal = "**不是标记**";');
  await page.getByRole("tab", { name: "live.md", exact: true }).click();
  await expect(page.locator(".editor-layout")).toHaveAttribute(
    "data-mode",
    "live",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('[data-live-preview="true"]')).toHaveCount(1);
  await expect(page.locator(".cm-live-heading").first()).toContainText(
    "标题 😀",
  );
  await expect(page.locator(".cm-live-strong").first()).toHaveText("粗体");
  await expect(editor(page)).toBeVisible();
  await expect(page.getByRole("region", { name: "文档预览" })).toHaveCount(0);
  await openDocumentOptions(page);
  for (const label of ["源码", "分栏", "预览", "实时渲染"])
    await expect(
      page.getByRole("menuitemradio", { name: label, exact: true }),
    ).toBeInViewport({ ratio: 1 });
  await expect(
    page.getByRole("menuitemradio", { name: "实时渲染", exact: true }),
  ).toHaveAttribute("aria-checked", "true");
  await expect(
    page.getByRole("menuitemradio", { name: "分栏", exact: true }),
  ).toHaveAttribute("aria-disabled", "true");
  await page.keyboard.press("Escape");
  await editorMenuClosed(page);
  await chooseEditorMode(page, "预览");
  await expect(editor(page)).toBeHidden();
  await expect(page.locator(".editor-layout")).toHaveAttribute(
    "data-mode",
    "preview",
  );
  await expectEditorMode(page, "预览");
  await chooseEditorMode(page, "实时渲染");
  await expect(editor(page)).toBeVisible();
  await expect(page.locator('[data-live-preview="true"]')).toHaveCount(1);
  await page.screenshot({ path: testInfo.outputPath("live-mobile.png") });
});

test("cross-marker deletion and multiline paste edit only the underlying source", async ({
  page,
}) => {
  await live(page, "live.md", markdown);
  const from = markdown.indexOf("**粗体**");
  const to = markdown.indexOf("`x < y`") + "`x < y`".length;
  await select(page, from + 2);
  await expect(editor(page)).toContainText("**粗体**");
  await page.keyboard.press("ArrowLeft");
  expect(
    await editor(page).evaluate(
      (element) =>
        (element as HTMLElement & { cmTile: { root: { view: EditorView } } })
          .cmTile.root.view.state.selection.main.head,
    ),
  ).toBe(from + 1);
  await page.keyboard.press("ArrowRight");
  await select(page, from, to);
  await page.keyboard.press("Backspace");
  const deleted = markdown.slice(0, from) + markdown.slice(to);
  await expect.poll(() => source(page)).toBe(deleted);
  const pasted = "😀 **粘贴**\n\n> 新引用\n";
  await editor(page).evaluate((element, text) => {
    const data = new DataTransfer();
    data.setData("text/plain", text);
    element.dispatchEvent(
      new ClipboardEvent("paste", {
        clipboardData: data,
        bubbles: true,
        cancelable: true,
      }),
    );
  }, pasted);
  const expected = markdown.slice(0, from) + pasted + markdown.slice(to);
  await expect.poll(() => source(page)).toBe(expected);
  await select(page, expected.length);
  await expect(
    page.locator(".cm-live-strong").filter({ hasText: "粘贴" }),
  ).toHaveText("粘贴");
  await page.keyboard.press("Control+s");
  await expect(page.getByRole("status", { name: "保存状态" })).toHaveText(
    "已保存",
  );
  await expect.poll(() => readFile(page, "live.md")).toBe(expected);
});

test("core undo and redo preserve Markdown delimiters in live mode", async ({
  page,
}) => {
  await live(page, "live.md", markdown);
  const from = markdown.indexOf("粗体");
  await select(page, from, from + "粗体".length);
  await page.keyboard.insertText("新的粗体");
  const edited = markdown.replace("粗体", "新的粗体");
  await expect.poll(() => source(page)).toBe(edited);
  await page.keyboard.press("Control+z");
  await expect.poll(() => source(page)).toBe(markdown);
  await page.keyboard.press("Control+y");
  await expect.poll(() => source(page)).toBe(edited);
  await select(page, edited.length);
  await expect(page.locator(".cm-live-strong").first()).toHaveText("新的粗体");
  await page.keyboard.press("Control+s");
  await expect(page.getByRole("status", { name: "保存状态" })).toHaveText(
    "已保存",
  );
  await expect.poll(() => readFile(page, "live.md")).toBe(edited);
});

test("composition keeps newly typed syntax visible until completion and preserves the final Chinese text", async ({
  page,
}) => {
  const initial = markdown + "\n\n输入：";
  await live(page, "ime.md", initial);
  const composed = "中文 **输入**\n\n继续";
  await editor(page).dispatchEvent("compositionstart");
  await page.keyboard.insertText(composed);
  await expect.poll(() => source(page)).toBe(initial + composed);
  // Wait past the syntax worker's delay so a result really arrives while IME is active.
  await page.waitForTimeout(150);
  await expect(page.locator(".cm-line").filter({ hasText: "中文" })).toHaveText(
    "输入：中文 **输入**",
  );
  await expect(
    page.locator(".cm-live-strong").filter({ hasText: "输入" }),
  ).toHaveCount(0);
  await editor(page).dispatchEvent("compositionend", { data: composed });
  await expect(
    page.locator(".cm-live-strong").filter({ hasText: "输入" }),
  ).toHaveText("输入");
  await expect(editor(page)).toBeFocused();
  await page.keyboard.press("Control+s");
  await expect(page.getByRole("status", { name: "保存状态" })).toHaveText(
    "已保存",
  );
  await expect.poll(() => readFile(page, "ime.md")).toBe(initial + composed);
});

test("switching tabs during composition releases the source barrier and cached live presentation", async ({
  page,
}) => {
  const initial = markdown + "\n\n输入：";
  const composed = "中文 **切换输入**\n\n末尾";
  await live(page, "ime.md", initial);
  await editor(page).dispatchEvent("compositionstart");
  await page.keyboard.insertText(composed);
  await expect.poll(() => source(page)).toBe(initial + composed);
  await page.waitForTimeout(150);
  await expect(
    page.locator(".cm-live-strong").filter({ hasText: "切换输入" }),
  ).toHaveCount(0);

  // The old view receives no compositionend when its tab is unmounted. Its
  // cached state and document-session barrier both need an explicit release.
  await page.getByRole("treeitem", { name: "plain.ts", exact: true }).click();
  await expect(editor(page)).toHaveText('const literal = "**不是标记**";');
  await page.getByRole("tab", { name: "ime.md", exact: true }).click();
  await expect.poll(() => source(page)).toBe(initial + composed);
  await expect(
    page.locator(".cm-live-strong").filter({ hasText: "切换输入" }),
  ).toHaveText("切换输入");
  await editor(page).focus();
  await page.keyboard.press("Control+s");
  await expect(page.getByRole("status", { name: "保存状态" })).toHaveText(
    "已保存",
  );
  await expect.poll(() => readFile(page, "ime.md")).toBe(initial + composed);
});

test("F12 follows a live-rendered link and keeps live mode, focus and source selection", async ({
  page,
}) => {
  await live(page, "live.md", markdown);
  await expect(page.locator(".cm-live-link").first()).toHaveText("链接");
  await select(page, markdown.indexOf("链接") + 1);
  await expect(editor(page)).toContainText("[链接](target.md)");
  await page.keyboard.press("F12");
  await expect(
    page.getByRole("tab", { name: "target.md", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".editor-layout")).toHaveAttribute(
    "data-mode",
    "live",
  );
  await expect(page.locator('[data-live-preview="true"]')).toHaveCount(1);
  await expect(editor(page)).toBeFocused();
  expect(await source(page)).toBe("# 目标\n");
  expect(
    await editor(page).evaluate(
      (element) =>
        (element as HTMLElement & { cmTile: { root: { view: EditorView } } })
          .cmTile.root.view.state.selection.main.head,
    ),
  ).toBe(0);
});

test("compressed blank lines stay clickable and editable, and multiline setext headings expose their underline", async ({
  page,
}) => {
  const content = spaced;
  await page.getByRole("treeitem", { name: "spaced.md", exact: true }).click();
  await chooseEditorMode(page, "实时渲染");
  await editor(page).focus();
  await select(page, content.length);
  const blank = editor(page).locator(".cm-line").nth(1);
  await expect(blank).toHaveClass(/cm-live-separator/);
  const bounds = await blank.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.height).toBeGreaterThan(0);
  await blank.click({ position: { x: 4, y: bounds!.height / 2 } });
  const caret = await editor(page).evaluate(
    (element) =>
      (element as HTMLElement & { cmTile: { root: { view: EditorView } } })
        .cmTile.root.view.state.selection.main.head,
  );
  const from = content.indexOf("\n\n\n") + 1;
  expect(caret).toBeGreaterThanOrEqual(from);
  expect(caret).toBeLessThan(from + 2);
  await expect(blank).not.toHaveClass(/cm-live-separator/);
  await page.keyboard.insertText("新增中文");
  await expect
    .poll(() => source(page))
    .toBe(content.slice(0, caret) + "新增中文" + content.slice(caret));
  const inserted = editor(page)
    .locator(".cm-line")
    .filter({ hasText: "新增中文" });
  await expect(inserted).not.toHaveClass(/cm-live-separator/);
  await expect(inserted).toBeVisible();
  expect(
    await inserted.evaluate((element) =>
      parseFloat(getComputedStyle(element).lineHeight),
    ),
  ).toBeGreaterThan(20);
  await page.keyboard.press("Control+z");
  await expect.poll(() => source(page)).toBe(content);
  await select(page, content.length);
  await expect(blank).toHaveClass(/cm-live-separator/);

  for (const text of ["多行标题", "仍是标题"])
    await expect(
      editor(page).locator(".cm-live-heading").filter({ hasText: text }),
    ).toHaveText(text);
  const underline = editor(page).locator(".cm-live-heading-marker");
  await expect(underline).toHaveCount(1);
  await expect(underline).toHaveText("");
  expect((await underline.boundingBox())!.height).toBeLessThanOrEqual(1.1);
  await select(page, content.indexOf("仍是标题") + 1);
  await expect(
    editor(page).locator(".cm-line").filter({ hasText: "========" }),
  ).toHaveText("========");
  await expect(underline).toHaveCount(0);
  await select(page, content.length);
  await expect(underline).toHaveCount(1);
  await expect(underline).toHaveText("");
  expect(await source(page)).toBe(content);
});

for (const extension of ["md", "not"] as const)
  test(`${extension} live typography matches its actual preview across themes and narrow screens`, async ({
    page,
  }, testInfo) => {
    test.setTimeout(60000);
    const native = extension === "not";
    const headingTexts = Array.from(
      { length: 6 },
      (_, index) => `级别 ${index + 1} Title ${index + 1}`,
    );
    const normal = "正文样本：普通文字 Plain text 😀。";
    const paragraphA = "段落甲：第一段正文。";
    const paragraphB = "段落乙：第二段正文。";
    const long =
      "长段落：" + "中文排版与自然换行 alpha beta gamma。 ".repeat(8);
    const quote = "引用样本：这段内容沿用正文行高和独立的引用边框。";
    const content =
      headingTexts
        .map(
          (text, index) => `${(native ? "=" : "#").repeat(index + 1)} ${text}`,
        )
        .join("\n\n") +
      "\n\n" +
      [
        normal,
        native
          ? "*加粗样本*、_斜体样本_、`code < value` 和 [链接样本](target.md)。"
          : "**加粗样本**、*斜体样本*、`code < value` 和 [链接样本](target.md)。",
        paragraphA,
        paragraphB,
        long,
        ...(native ? [] : [`> ${quote}`]),
        "编辑位置",
      ].join("\n\n");
    await page
      .getByRole("treeitem", { name: `live.${extension}`, exact: true })
      .click();
    const wrap = page.getByRole("menuitemcheckbox", {
      name: "自动换行",
      exact: true,
    });
    await openDocumentOptions(page);
    await expect(wrap).toHaveAttribute("aria-checked", "false");
    await page.keyboard.press("Escape");
    await editorMenuClosed(page);
    await editor(page).focus();
    await page.keyboard.press("Control+a");
    await page.keyboard.insertText(content);
    await expect.poll(() => source(page)).toBe(content);

    for (const width of [1280, 390])
      for (const theme of ["light", "dark"] as const) {
        await page.setViewportSize({ width, height: 1400 });
        await page.evaluate(async (theme) => {
          const { setTheme } = await import("/src/lib/theme.ts" as string);
          await setTheme(theme);
        }, theme);
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
        const selectors = (live: boolean) => [
          ...headingTexts.map((text, index) => ({
            name: `h${index + 1}`,
            selector: live
              ? `.cm-live-heading[data-live-level="${index + 1}"]`
              : `h${index + 1}`,
            text,
          })),
          { name: "normal", selector: live ? ".cm-line" : "p", text: normal },
          {
            name: "strong",
            selector: live ? ".cm-live-strong" : "strong",
            text: "加粗样本",
          },
          {
            name: "emphasis",
            selector: live ? ".cm-live-emphasis" : "em",
            text: "斜体样本",
          },
          {
            name: "code",
            selector: live ? ".cm-live-code" : "code",
            text: "code < value",
          },
          {
            name: "link",
            selector: live ? ".cm-live-link" : "a",
            text: "链接样本",
          },
          {
            name: "paragraphA",
            selector: live ? ".cm-line" : "p",
            text: paragraphA,
          },
          {
            name: "paragraphB",
            selector: live ? ".cm-line" : "p",
            text: paragraphB,
          },
          {
            name: "long",
            selector: live ? ".cm-line" : "p",
            text: long.trimEnd(),
          },
          ...(native
            ? []
            : [
                {
                  name: "quote",
                  selector: live ? ".cm-live-quote" : "blockquote",
                  text: quote,
                },
              ]),
        ];
        const prefix = `typography-${extension}-${width}-${theme}`;
        await chooseEditorMode(page, "预览");
        const preview = page.getByRole("region", { name: "文档预览" });
        await expect(page.getByRole("status", { name: "预览状态" })).toHaveText(
          "预览已更新",
        );
        await expect(preview.locator("h6")).toHaveText(headingTexts[5]!);
        await page.evaluate(() => document.fonts.ready.then(() => undefined));
        const reference = await typographySample(
          preview.locator("article"),
          selectors(false),
        );
        await preview
          .locator(".preview-scroller")
          .screenshot({ path: testInfo.outputPath(`${prefix}-preview.png`) });

        await chooseEditorMode(page, "实时渲染");
        await expect(page.locator('[data-live-preview="true"]')).toHaveCount(1);
        await select(page, content.length);
        await expect(page.locator(".cm-live-heading")).toHaveCount(6);
        await expect(page.locator(".cm-live-strong")).toHaveText("加粗样本");
        await openDocumentOptions(page);
        await expect(wrap).toHaveCount(0);
        await page.keyboard.press("Escape");
        await editorMenuClosed(page);
        await expect(editor(page)).toHaveClass(/cm-lineWrapping/);
        await page.evaluate(() => document.fonts.ready.then(() => undefined));
        const actual = await typographySample(editor(page), selectors(true));
        await page
          .locator(".cm-scroller")
          .screenshot({ path: testInfo.outputPath(`${prefix}-live.png`) });
        await testInfo.attach(`${prefix}-metrics`, {
          body: JSON.stringify({ reference, actual }, null, 2),
          contentType: "application/json",
        });

        for (const name of Object.keys(reference)) {
          const expected = reference[name]!;
          const rendered = actual[name]!;
          expect(
            rendered.styles,
            `${prefix}: ${name} leaf styles`,
          ).toHaveLength(expected.styles.length);
          for (let index = 0; index < expected.styles.length; index++) {
            const before = expected.styles[index]!;
            const after = rendered.styles[index]!;
            for (const key of [
              "fontFamily",
              "fontWeight",
              "fontStyle",
              "color",
            ] as const)
              expect(after[key], `${prefix}: ${name} ${key}`).toBe(before[key]);
            for (const key of ["fontSize", "lineHeight"] as const)
              expect(after[key], `${prefix}: ${name} ${key}`).toBeCloseTo(
                before[key],
                1,
              );
          }
        }
        for (const key of [
          "background",
          "radius",
          "paddingLeft",
          "paddingRight",
          "paddingTop",
          "paddingBottom",
        ] as const)
          expect(actual.code!.decoration[key], `${prefix}: code ${key}`).toBe(
            reference.code!.decoration[key],
          );
        expect(actual.link!.decoration.underline).toContain("underline");
        expect(actual.link!.decoration.underlineOffset).toBe(
          reference.link!.decoration.underlineOffset,
        );
        if (!native) {
          expect(actual.quote!.decoration.borderLeftWidth).toBe(
            reference.quote!.decoration.borderLeftWidth,
          );
          expect(actual.quote!.decoration.borderLeftColor).toBe(
            reference.quote!.decoration.borderLeftColor,
          );
          expect(actual.quote!.decoration.paddingLeft).toBe(
            reference.quote!.decoration.paddingLeft,
          );
        }
        expect(
          Math.abs(
            actual.normal!.column.width - reference.normal!.column.width,
          ),
        ).toBeLessThanOrEqual(1);
        expect(
          Math.abs(
            actual.normal!.column.center - actual.normal!.column.paneWidth / 2,
          ),
        ).toBeLessThanOrEqual(1);
        expect(actual.long!.text.rows).toBe(reference.long!.text.rows);
        const actualGap =
          actual.paragraphB!.text.top - actual.paragraphA!.text.bottom;
        const previewGap =
          reference.paragraphB!.text.top - reference.paragraphA!.text.bottom;
        expect(
          Math.abs(actualGap - previewGap),
          `${prefix}: paragraph gap`,
        ).toBeLessThanOrEqual(2);
        for (const [before, after] of [
          ["h1", "h2"],
          ["h2", "h3"],
          ["h3", "h4"],
          ["h4", "h5"],
          ["h5", "h6"],
          ["h6", "normal"],
        ] as const) {
          const actualGap =
            actual[after]!.text.top - actual[before]!.text.bottom;
          const previewGap =
            reference[after]!.text.top - reference[before]!.text.bottom;
          expect(
            Math.abs(actualGap - previewGap),
            `${prefix}: ${before} to ${after} gap`,
          ).toBeLessThanOrEqual(2);
        }
        expect(actual.normal!.column.scrollWidth).toBeLessThanOrEqual(
          actual.normal!.column.clientWidth + 1,
        );
        expect(await source(page)).toBe(content);
      }
    await chooseEditorMode(page, "源码");
    await openDocumentOptions(page);
    await expect(wrap).toBeVisible();
    await expect(wrap).toHaveAttribute("aria-checked", "false");
    await page.keyboard.press("Escape");
    await editorMenuClosed(page);
    await expect(editor(page)).not.toHaveClass(/cm-lineWrapping/);
    expect(await source(page)).toBe(content);
  });

for (const extension of ["md", "not"] as const)
  test(`${extension} headings retain their preview spacing without an intervening blank source line`, async ({
    page,
  }) => {
    const heading = "没有空行的标题";
    const paragraph = "紧邻标题的正文仍然需要自然的阅读间距。";
    const content = `${extension === "not" ? "=" : "#"} ${heading}\n${paragraph}\n\n编辑位置`;
    await page
      .getByRole("treeitem", { name: `live.${extension}`, exact: true })
      .click();
    await editor(page).fill(content);
    await chooseEditorMode(page, "预览");
    const preview = page.getByRole("region", { name: "文档预览" });
    await expect(preview.locator("h1")).toHaveText(heading);
    await expect(
      preview.locator("p").filter({ hasText: paragraph }),
    ).toHaveText(paragraph);
    const reference = await typographySample(preview.locator("article"), [
      { name: "heading", selector: "h1", text: heading },
      { name: "body", selector: "p", text: paragraph },
    ]);
    await chooseEditorMode(page, "实时渲染");
    await select(page, content.length);
    await expect(page.locator(".cm-live-heading")).toHaveText(heading);
    const actual = await typographySample(editor(page), [
      { name: "heading", selector: ".cm-live-heading", text: heading },
      { name: "body", selector: ".cm-line", text: paragraph },
    ]);
    const previewGap =
      reference.body!.text.top - reference.heading!.text.bottom;
    const liveGap = actual.body!.text.top - actual.heading!.text.bottom;
    expect(previewGap).toBeGreaterThan(0);
    expect(Math.abs(liveGap - previewGap)).toBeLessThanOrEqual(2);
    expect(await source(page)).toBe(content);
  });
