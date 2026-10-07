import { expect, test as base } from "@playwright/test";
import { installWorkerHarness, workerEvaluate } from "./worker-harness";
const test = base.extend<{ runtimeErrors: string[] }>({
  runtimeErrors: [
    async ({ page }, use) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => {
        if (message.text().includes("REACTIVITY_HALTED"))
          errors.push(message.text());
      });
      await use(errors);
      expect(errors).toEqual([]);
    },
    { auto: true },
  ],
});

test.beforeEach(async ({ page }) => {
  await installWorkerHarness(page);
  await page.goto("/");
  await page.evaluate(async () => {
    const url = "/src/lib/vault/index.ts";
    const { openOpfsVault, vaultPath } = await import(url);
    const vault = await openOpfsVault();
    await vault.mkdir(vaultPath("notes"));
    for (const [path, source] of [
      [
        "a.md",
        "# First\n\n**bold** and `a < b`\n\n" + "paragraph\n\n".repeat(100),
      ],
      [
        "a.not",
        '@(id: "spot")\n= Notist\n\n[go](notes/b.not#dest) [missing](missing.not) [escape](../outside.not)\n\n😀中文 #unknown[ok]',
      ],
      ["notes/b.not", '@(id: "dest")\n= Destination\n\n目标正文'],
      [
        "range.md",
        "# Range\n\n" +
          "padding\n\n".repeat(25) +
          "```rust\n" +
          'println!("long range");\n'.repeat(40) +
          "```\n\n" +
          "tail\n\n".repeat(50),
      ],
      [
        "sync.md",
        Array.from(
          { length: 70 },
          (_, index) =>
            `## Section ${index}\n\n段落 ${index} 😀 &amp; **强调** ${"较长的正文 ".repeat(18)}\n\n- first\n  - nested\n\n` +
            (index % 4 === 0
              ? "```rust\n" + 'println!("example");\n'.repeat(12) + "```\n\n"
              : "") +
            (index % 7 === 0 ? "| X | Y |\n| --- | --- |\n| a | b |\n\n" : ""),
        ).join(""),
      ],
    ])
      await vault.writeFile(vaultPath(path), new TextEncoder().encode(source), {
        mode: "create",
      });
    await vault.close();
  });
  await page.reload();
  await expect(
    page.getByRole("treeitem", { name: "a.md", exact: true }),
  ).toBeVisible();
});

test("display mode is shared across files and Vaults and persists through settings and reload", async ({
  page,
}) => {
  const preview = page.getByRole("region", { name: "文档预览" });
  const editor = page.getByRole("textbox", { name: "代码编辑器" });
  await page.getByRole("treeitem", { name: "a.md", exact: true }).click();
  await page.getByRole("button", { name: "分栏", exact: true }).click();
  await page.getByRole("treeitem", { name: "a.not", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "分栏", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(preview.locator("h1")).toHaveText("Notist");
  await page.getByRole("button", { name: "预览", exact: true }).click();
  await page.getByRole("tab", { name: "a.md", exact: true }).click();
  await expect(preview.locator("h1")).toHaveText("First");
  await expect(editor).toHaveCount(0);
  await page.getByRole("button", { name: "源码", exact: true }).click();
  await page.getByRole("tab", { name: "a.not", exact: true }).click();
  await expect(preview).toHaveCount(0);
  await expect(editor).toBeVisible();
  await page.getByRole("button", { name: "分栏", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(async () => {
        try {
          const root = await navigator.storage.getDirectory();
          const directory = await root.getDirectoryHandle("celestite");
          const file = await directory.getFileHandle("settings.json");
          return JSON.parse(await (await file.getFile()).text())[
            "editor.previewMode"
          ];
        } catch (error) {
          // Creation may still be pending, and an overlapping settings write
          // can invalidate the File snapshot between getFile() and text().
          if (
            error instanceof DOMException &&
            ["NotFoundError", "NotReadableError"].includes(error.name)
          )
            return null;
          throw error;
        }
      }),
    )
    .toBe("split");
  await page.reload();
  await page.getByRole("treeitem", { name: "range.md", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "分栏", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(preview.locator("h1")).toHaveText("Range");
  await page.evaluate(async () => {
    const root = await (
      await navigator.storage.getDirectory()
    ).getDirectoryHandle("Shared Mode", { create: true });
    const stream = await (
      await root.getFileHandle("local.md", { create: true })
    ).createWritable();
    await stream.write("# Local Vault");
    await stream.close();
    Object.assign(window, { showDirectoryPicker: async () => root });
  });
  await page.getByRole("button", { name: "管理 Vault", exact: true }).click();
  await page.getByRole("button", { name: "打开本机目录", exact: true }).click();
  await page.getByRole("treeitem", { name: "local.md", exact: true }).click();
  await expect(preview.locator("h1")).toHaveText("Local Vault");
  await expect(
    page.getByRole("button", { name: "分栏", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "全局设置", exact: true }).click();
  await page
    .getByRole("combobox", { name: "文档显示模式", exact: true })
    .selectOption("preview");
  await expect(page.getByRole("status", { name: "设置保存状态" })).toHaveText(
    "已保存",
  );
  await page.keyboard.press("Escape");
  await page
    .getByRole("combobox", { name: "当前 Vault" })
    .selectOption("opfs:default");
  await expect(preview.locator("h1")).toHaveText("Range");
  await expect(editor).toHaveCount(0);
  await page.reload();
  await page.getByRole("treeitem", { name: "a.md", exact: true }).click();
  await expect(preview.locator("h1")).toHaveText("First");
  await expect(editor).toHaveCount(0);
});

test("split click mapping preserves split mode and rejects stale or dragged content", async ({
  page,
}, testInfo) => {
  await workerEvaluate(page, () => {
    const runtime = self as unknown as {
      Worker: typeof Worker;
      holdPreview?: boolean;
      resumePreview?: () => void;
    };
    runtime.Worker = class extends Worker {
      private preview: boolean;
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        this.preview = String(url).includes("/preview/worker.ts");
      }
      postMessage(message: unknown) {
        if (this.preview && runtime.holdPreview)
          runtime.resumePreview = () => {
            runtime.holdPreview = false;
            super.postMessage(message);
          };
        else super.postMessage(message);
      }
    };
  });
  await page.getByRole("treeitem", { name: "sync.md", exact: true }).click();
  await page.getByRole("button", { name: "分栏", exact: true }).click();
  const preview = page.getByRole("region", { name: "文档预览" });
  const editor = page.getByRole("textbox", { name: "代码编辑器" });
  await expect(preview.locator("h2").first()).toHaveText("Section 0");
  await preview.locator("h2").first().click();
  await expect(editor).toBeFocused();
  await expect(
    page.getByRole("button", { name: "分栏", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect
    .poll(() => page.evaluate(() => window.getSelection()?.toString()))
    .toContain("Section 0");
  await page
    .locator(".cm-line")
    .filter({ hasText: /^## Section 1$/ })
    .click({ position: { x: 65, y: 8 } });
  await expect(preview.locator("[data-notist-sync-target]")).toContainText(
    "Section 1",
  );
  const paragraph = preview
    .locator("p")
    .filter({ hasText: /段落 1 😀/ })
    .first();
  await paragraph
    .locator("span[data-notist-node]")
    .filter({ hasText: /^段落 1 😀/ })
    .first()
    .click({ position: { x: 40, y: 10 } });
  await expect
    .poll(() => page.evaluate(() => window.getSelection()?.toString()))
    .toContain("😀 &amp;");
  await expect(page.getByText(/^Ln \d+, Col \d+$/)).toContainText("Ln 29,");
  await page.screenshot({
    path: testInfo.outputPath("preview-source-mapping.png"),
  });
  // A drag selects preview text without replacing the source selection/focus.
  const rect = await paragraph.boundingBox();
  if (!rect) throw new Error("No preview paragraph bounds");
  await page.mouse.move(rect.x + 5, rect.y + 10);
  await page.mouse.down();
  await page.mouse.move(rect.x + 130, rect.y + 10, { steps: 8 });
  await page.mouse.up();
  await expect(editor).not.toBeFocused();
  // Until the next render, old mapping cannot move the source selection.
  await workerEvaluate(page, () => {
    (self as unknown as { holdPreview: boolean }).holdPreview = true;
  });
  await editor.focus();
  await page.keyboard.press("Control+a");
  await page.keyboard.insertText("# Fresh body");
  await preview
    .locator("h2")
    .first()
    .dispatchEvent("click", { button: 0, clientX: 0, clientY: 0 });
  await expect
    .poll(() => page.evaluate(() => window.getSelection()?.toString()))
    .toBe("");
  await expect
    .poll(() =>
      workerEvaluate(
        page,
        () =>
          typeof (self as unknown as { resumePreview?: () => void })
            .resumePreview,
      ),
    )
    .toBe("function");
  await workerEvaluate(page, () =>
    (self as unknown as { resumePreview: () => void }).resumePreview(),
  );
  await expect(preview.locator("h1")).toHaveText("Fresh body");
});

test("split clicks keep visible targets still and scrolling resumes without snapping back", async ({
  page,
}) => {
  await page.getByRole("treeitem", { name: "sync.md", exact: true }).click();
  await page.getByRole("button", { name: "分栏", exact: true }).click();
  const preview = page.getByRole("region", { name: "文档预览" });
  const sourceScroller = page.locator(".cm-scroller");
  const previewScroller = preview.locator(".preview-scroller");
  const sourceHeading = page
    .locator(".cm-line")
    .filter({ hasText: /^## Section 1$/ });
  const previewHeading = preview
    .locator("h2")
    .filter({ hasText: /^Section 1$/ });
  await expect(previewHeading).toBeVisible();
  // Intentionally show the same target at different heights in the two panes.
  await sourceHeading.evaluate((element) => {
    const scroller = element.closest(".cm-scroller")!;
    scroller.scrollTop +=
      element.getBoundingClientRect().top -
      scroller.getBoundingClientRect().top -
      160;
  });
  await previewHeading.evaluate((element) => {
    const scroller = (element.getRootNode() as ShadowRoot).host.closest(
      ".preview-scroller",
    )!;
    scroller.scrollTop +=
      element.getBoundingClientRect().top -
      scroller.getBoundingClientRect().top -
      320;
  });
  const positions = async () => ({
    source: await sourceScroller.evaluate((element) => element.scrollTop),
    preview: await previewScroller.evaluate((element) => element.scrollTop),
  });
  const before = await positions();
  await sourceHeading.click({ position: { x: 65, y: 8 } });
  await expect(preview.locator("[data-notist-sync-target]")).toContainText(
    "Section 1",
  );
  await previewHeading.click();
  await expect(page.getByRole("textbox", { name: "代码编辑器" })).toBeFocused();
  await expect
    .poll(() => page.evaluate(() => window.getSelection()?.toString()))
    .toContain("Section 1");
  await page.waitForTimeout(120);
  expect(await positions()).toEqual(before);
  // The first small scroll after the click must not undo the viewport choice.
  await sourceScroller.evaluate((element) => {
    element.dispatchEvent(new WheelEvent("wheel", { deltaY: 8 }));
    element.scrollTop += 8;
  });
  await expect
    .poll(() => previewScroller.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(before.preview);
  expect((await positions()).preview - before.preview).toBeLessThan(40);
  const after = await positions();
  await previewScroller.evaluate((element) => {
    element.dispatchEvent(new WheelEvent("wheel", { deltaY: 8 }));
    element.scrollTop += 8;
  });
  await expect
    .poll(() => sourceScroller.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(after.source);
  expect((await positions()).source - after.source).toBeLessThan(40);

  // Screen-external targets still move into view, in both directions.
  await previewHeading.click();
  await previewScroller.evaluate((element) => {
    element.scrollTop = 12000;
  });
  await sourceHeading.click({ position: { x: 65, y: 8 } });
  await expect
    .poll(() =>
      previewHeading.evaluate((element) => {
        const scroller = (element.getRootNode() as ShadowRoot).host.closest(
          ".preview-scroller",
        )!;
        return (
          element.getBoundingClientRect().top -
          scroller.getBoundingClientRect().top
        );
      }),
    )
    .toBeGreaterThanOrEqual(0);
  expect(
    await previewHeading.evaluate((element) => {
      const scroller = (element.getRootNode() as ShadowRoot).host.closest(
        ".preview-scroller",
      )!;
      return (
        element.getBoundingClientRect().bottom <=
        scroller.getBoundingClientRect().bottom
      );
    }),
  ).toBe(true);
  await sourceScroller.evaluate((element) => {
    element.scrollTop = 12000;
  });
  await previewHeading.click();
  await expect(sourceHeading).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => window.getSelection()?.toString()))
    .toContain("Section 1");
});

test("preview click on a long node keeps its visible source start in place", async ({
  page,
}) => {
  await page.getByRole("treeitem", { name: "range.md", exact: true }).click();
  await page.getByRole("button", { name: "分栏", exact: true }).click();
  const preview = page.getByRole("region", { name: "文档预览" });
  const source = page.locator(".cm-scroller");
  await expect(preview.locator("pre")).toContainText("long range");
  await source.evaluate((element) => {
    element.scrollTop = 850;
  });
  await page
    .locator(".cm-line")
    .filter({ hasText: /^println!\("long range"\);$/ })
    .first()
    .evaluate((element) => {
      const scroller = element.closest(".cm-scroller")!;
      scroller.scrollTop +=
        element.getBoundingClientRect().top -
        scroller.getBoundingClientRect().top -
        scroller.clientHeight +
        40;
    });
  const before = await source.evaluate((element) => element.scrollTop);
  await preview.locator("pre").click({ position: { x: 20, y: 12 } });
  await expect(page.getByRole("textbox", { name: "代码编辑器" })).toBeFocused();
  await expect
    .poll(() => page.evaluate(() => window.getSelection()?.toString()))
    .toContain('println!("long range");');
  await page.waitForTimeout(120);
  expect(await source.evaluate((element) => element.scrollTop)).toBeCloseTo(
    before,
    0,
  );
});

test("split scroll uses content anchors in both directions without changing focus or selection", async ({
  page,
}) => {
  await page.getByRole("treeitem", { name: "sync.md", exact: true }).click();
  await page.getByRole("button", { name: "分栏", exact: true }).click();
  const preview = page.getByRole("region", { name: "文档预览" });
  await expect(preview.locator("h2").first()).toHaveText("Section 0");
  const editor = page.getByRole("textbox", { name: "代码编辑器" });
  await editor.focus();
  const cursor = await page.getByText(/^Ln \d+, Col \d+$/).textContent();
  const source = page.locator(".cm-scroller");
  await source.evaluate((element) => {
    element.dispatchEvent(new WheelEvent("wheel", { deltaY: 1500 }));
    element.scrollTop = 1500;
  });
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  const heading = await page.locator(".cm-line").evaluateAll((elements) => {
    const scroller = document.querySelector(".cm-scroller")!;
    const top = scroller.getBoundingClientRect().top;
    const candidates = elements.filter(
      (element) =>
        /^## Section \d+$/.test(element.textContent ?? "") &&
        element.getBoundingClientRect().top >= top,
    );
    const element = candidates[0];
    if (!element) throw new Error("No visible source heading");
    return {
      text: element.textContent!.slice(3),
      top: element.getBoundingClientRect().top - top,
    };
  });
  await expect
    .poll(async () => {
      const top = await preview
        .locator("h2")
        .filter({ hasText: new RegExp(`^${heading.text}$`) })
        .evaluate((element) => {
          const scroller = element.getRootNode() as ShadowRoot;
          const viewport = scroller.host.closest(".preview-scroller")!;
          return (
            element.getBoundingClientRect().top -
            viewport.getBoundingClientRect().top
          );
        });
      return Math.abs(top - heading.top);
    })
    .toBeLessThan(28);
  await preview
    .locator("h2")
    .filter({ hasText: /^Section 40$/ })
    .evaluate((element) => {
      const root = element.getRootNode() as ShadowRoot;
      const scroller = root.host.closest(".preview-scroller")!;
      scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: 2000 }));
      scroller.scrollTop +=
        element.getBoundingClientRect().top -
        scroller.getBoundingClientRect().top -
        16;
    });
  await expect(
    page.locator(".cm-line").filter({ hasText: /^## Section 40$/ }),
  ).toBeVisible();
  await expect(editor).toBeFocused();
  await expect(page.getByText(/^Ln \d+, Col \d+$/)).toHaveText(cursor!);
  const followedTop = await source.evaluate((element) => element.scrollTop);
  await page.waitForTimeout(120);
  expect(await source.evaluate((element) => element.scrollTop)).toBeCloseTo(
    followedTop,
    0,
  );
  await page.getByRole("button", { name: "滚动同步", exact: true }).click();
  const previewTop = await preview
    .locator(".preview-scroller")
    .evaluate((element) => element.scrollTop);
  await source.evaluate((element) => {
    element.dispatchEvent(new WheelEvent("wheel", { deltaY: 600 }));
    element.scrollTop += 600;
  });
  await page.waitForTimeout(120);
  expect(
    await preview
      .locator(".preview-scroller")
      .evaluate((element) => element.scrollTop),
  ).toBeCloseTo(previewTop, 0);
});

test("live split preview keeps the editor session and preview scroll across mode switches", async ({
  page,
}) => {
  await page.getByRole("treeitem", { name: "a.md", exact: true }).click();
  const editor = page.getByRole("textbox", { name: "代码编辑器" });
  await page.getByRole("button", { name: "分栏", exact: true }).click();
  const preview = page.getByRole("region", { name: "文档预览" });
  await expect(preview.locator("h1")).toHaveText("First");
  await expect(preview.locator("strong")).toHaveText("bold");
  await expect(preview.locator("code")).toHaveText("a < b");
  await preview.locator(".preview-scroller").evaluate((element) => {
    element.scrollTop = 600;
  });
  await page.getByRole("button", { name: "源码", exact: true }).click();
  await expect(preview).toHaveCount(0);
  await page.getByRole("button", { name: "预览", exact: true }).click();
  await expect(preview.locator("h1")).toHaveText("First");
  await expect
    .poll(() =>
      preview
        .locator(".preview-scroller")
        .evaluate((element) => element.scrollTop),
    )
    .toBeGreaterThan(500);
  await expect(editor).toBeHidden();
  await page.getByRole("button", { name: "分栏", exact: true }).click();
  await editor.focus();
  await page.keyboard.press("Control+a");
  await page.keyboard.insertText("# Updated 😀\n\n未保存正文");
  await expect(preview.locator("h1")).toHaveText("Updated 😀");
  await expect(preview.locator("p")).toHaveText("未保存正文");
  await page.getByRole("button", { name: "预览", exact: true }).click();
  await page.getByRole("button", { name: "源码", exact: true }).click();
  await editor.focus();
  await page.keyboard.press("Control+z");
  await expect(editor).toContainText("First");
  await page.getByRole("button", { name: "分栏", exact: true }).click();
  await expect(preview.locator("h1")).toHaveText("First");
});

test("scroll anchors are remeasured after wrapping, folding and resizing", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.getByRole("treeitem", { name: "sync.md", exact: true }).click();
  await page.getByRole("button", { name: "分栏", exact: true }).click();
  const preview = page.getByRole("region", { name: "文档预览" });
  await expect(preview.locator("h2").first()).toHaveText("Section 0");
  const wrap = page.getByRole("button", { name: "自动换行", exact: true });
  if ((await wrap.getAttribute("aria-pressed")) !== "true") await wrap.click();
  await page.getByTitle("Fold line", { exact: true }).first().click();
  await expect(page.getByLabel("folded code")).toBeVisible();
  await page.setViewportSize({ width: 950, height: 780 });
  const source = page.locator(".cm-scroller");
  await source.evaluate((element) => {
    element.dispatchEvent(new WheelEvent("wheel", { deltaY: 2200 }));
    element.scrollTop = 2200;
  });
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  // Align one actual content anchor at the guide. Different paragraph heights
  // mean other headings in the viewport need not have identical screen Y.
  const anchorText = await page.locator(".cm-line").evaluateAll((elements) => {
    const viewport = document
      .querySelector(".cm-scroller")!
      .getBoundingClientRect();
    return elements.find(
      (element) =>
        /^## Section \d+$/.test(element.textContent ?? "") &&
        element.getBoundingClientRect().top >= viewport.top &&
        element.getBoundingClientRect().top < viewport.bottom,
    )?.textContent;
  });
  if (!anchorText) throw new Error("No visible anchor after resizing");
  await page
    .locator(".cm-line")
    .filter({ hasText: new RegExp(`^${anchorText}$`) })
    .evaluate((element) => {
      const scroller = element.closest(".cm-scroller")!;
      scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: 100 }));
      scroller.scrollTop +=
        element.getBoundingClientRect().top -
        scroller.getBoundingClientRect().top -
        16;
    });
  await expect
    .poll(async () => {
      const heading = await page.locator(".cm-line").evaluateAll((elements) => {
        const viewport = document
          .querySelector(".cm-scroller")!
          .getBoundingClientRect();
        const element = elements.find(
          (element) =>
            /^## Section \d+$/.test(element.textContent ?? "") &&
            element.getBoundingClientRect().top >= viewport.top &&
            element.getBoundingClientRect().top < viewport.bottom,
        );
        return element
          ? {
              text: element.textContent!.slice(3),
              top: element.getBoundingClientRect().top - viewport.top,
            }
          : undefined;
      });
      if (!heading) return 10000;
      const top = await preview
        .locator("h2")
        .filter({ hasText: new RegExp(`^${heading.text}$`) })
        .evaluate(
          (element) =>
            element.getBoundingClientRect().top -
            (element.getRootNode() as ShadowRoot).host
              .closest(".preview-scroller")!
              .getBoundingClientRect().top,
        );
      return Math.abs(top - heading.top);
    })
    .toBeLessThan(5);
  await preview
    .locator("h2")
    .filter({ hasText: /^Section 30$/ })
    .evaluate((element) => {
      const scroller = (element.getRootNode() as ShadowRoot).host.closest(
        ".preview-scroller",
      )!;
      scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: 3000 }));
      scroller.scrollTop +=
        element.getBoundingClientRect().top -
        scroller.getBoundingClientRect().top -
        16;
    });
  await expect(
    page.locator(".cm-line").filter({ hasText: /^## Section 30$/ }),
  ).toBeVisible();
});

test("Notist preview recovers errors, reports invalid links and opens Vault-relative documents", async ({
  page,
}) => {
  await page.getByRole("treeitem", { name: "a.not", exact: true }).click();
  await page.getByRole("button", { name: "分栏", exact: true }).click();
  const preview = page.getByRole("region", { name: "文档预览" });
  await expect(preview.locator("h1")).toHaveText("Notist");
  await expect(preview.locator(".notist-custom")).toHaveText("ok");
  await preview.locator(".notist-custom").click();
  await expect(page.getByRole("textbox", { name: "代码编辑器" })).toBeFocused();
  await expect
    .poll(() => page.evaluate(() => window.getSelection()?.toString()))
    .toContain("ok");
  await expect(
    page.getByRole("button", { name: "分栏", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await preview.getByRole("link", { name: "escape", exact: true }).click();
  await expect(preview.getByRole("alert")).toContainText("outside Vault");
  await preview.getByRole("link", { name: "missing", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("missing.not");
  await expect(preview.locator("h1")).toHaveText("Notist");
  await preview.getByRole("link", { name: "go", exact: true }).click();
  await expect(
    page.getByRole("tab", { name: "notes/b.not", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(preview.locator("h1")).toHaveText("Destination");
  await expect(preview.locator("#dest")).toBeVisible();
  await page.getByRole("tab", { name: "a.not", exact: true }).click();
  await expect(preview.locator("h1")).toHaveText("Notist");
  await preview.locator("summary").click();
  await preview
    .getByRole("button", { name: "unknown constructor `unknown`", exact: true })
    .click();
  await expect(preview).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "代码编辑器" })).toBeFocused();
});

test("preview executor failure leaves editing usable and retry creates a new Worker", async ({
  page,
}) => {
  await workerEvaluate(page, () => {
    const runtime = self as unknown as {
      Worker: typeof Worker;
      previewNativeWorker: typeof Worker;
    };
    runtime.previewNativeWorker = Worker;
    runtime.Worker = class extends Worker {
      constructor(url: string | URL, options?: WorkerOptions) {
        if (String(url).includes("/preview/worker.ts"))
          throw new Error("Injected preview executor failure");
        super(url, options);
      }
    };
  });
  await page.getByRole("treeitem", { name: "a.md", exact: true }).click();
  await page.getByRole("button", { name: "分栏", exact: true }).click();
  const preview = page.getByRole("region", { name: "文档预览" });
  await expect(preview.getByRole("status", { name: "预览状态" })).toHaveText(
    "预览失败",
  );
  const editor = page.getByRole("textbox", { name: "代码编辑器" });
  await editor.focus();
  await page.keyboard.press("Control+a");
  await page.keyboard.insertText("# Survived failure");
  await page.keyboard.press("Control+s");
  await expect(page.getByRole("status", { name: "保存状态" })).toHaveText(
    "已保存",
  );
  await expect(preview.getByRole("status", { name: "预览状态" })).toHaveText(
    "预览失败",
  );
  await workerEvaluate(page, () => {
    const runtime = self as unknown as {
      Worker: typeof Worker;
      previewNativeWorker: typeof Worker;
    };
    runtime.Worker = runtime.previewNativeWorker;
  });
  await preview.getByRole("button", { name: "重试预览" }).click();
  await expect(preview.locator("h1")).toHaveText("Survived failure");
});

test("a slow preview does not block saving and cannot publish an old snapshot", async ({
  page,
}) => {
  await workerEvaluate(page, () => {
    const runtime = self as unknown as {
      Worker: typeof Worker;
      releasePreview: () => void;
    };
    let held: (() => void) | undefined;
    runtime.Worker = class extends Worker {
      private preview: boolean;
      private hold = true;
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        this.preview = String(url).includes("/preview/worker.ts");
        if (this.preview)
          runtime.releasePreview = () => {
            this.hold = false;
            held?.();
          };
      }
      postMessage(message: unknown) {
        if (this.preview && this.hold) held = () => super.postMessage(message);
        else super.postMessage(message);
      }
    };
  });
  await page.getByRole("treeitem", { name: "a.md", exact: true }).click();
  await page.getByRole("button", { name: "分栏", exact: true }).click();
  const preview = page.getByRole("region", { name: "文档预览" });
  await expect
    .poll(() =>
      workerEvaluate(
        page,
        () =>
          typeof (self as unknown as { releasePreview?: () => void })
            .releasePreview,
      ),
    )
    .toBe("function");
  const editor = page.getByRole("textbox", { name: "代码编辑器" });
  await editor.focus();
  await page.keyboard.press("Control+a");
  await page.keyboard.insertText("# Latest while busy");
  await page.keyboard.press("Control+s");
  await expect(page.getByRole("status", { name: "保存状态" })).toHaveText(
    "已保存",
  );
  await expect(preview.locator("h1")).toHaveCount(0);
  await workerEvaluate(page, () =>
    (self as unknown as { releasePreview: () => void }).releasePreview(),
  );
  await expect(preview.locator("h1")).toHaveText("Latest while busy");
  await expect(preview.getByRole("status", { name: "预览状态" })).toHaveText(
    "预览已更新",
  );
});

test("preview prose follows the theme and remains usable on narrow screens", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.getByRole("treeitem", { name: "a.md", exact: true }).click();
  const editor = page.getByRole("textbox", { name: "代码编辑器" });
  await editor.focus();
  await page.keyboard.press("Control+a");
  await page.keyboard.insertText(
    '# 排版预览\n\n正文支持 **强调**、`a < b` 和 Unicode 😀。\n\n- 第一项\n  - 嵌套项\n- 第二项\n\n> 引用内容\n\n| 名称 | 内容 |\n| --- | --- |\n| 中文 | 单元格 |\n\n```rust\nfn main() { println!("hello"); }\n```\n',
  );
  await page.getByRole("button", { name: "分栏", exact: true }).click();
  const preview = page.getByRole("region", { name: "文档预览" });
  await expect(preview.locator("h1")).toHaveText("排版预览");
  await expect(preview.locator("ul ul")).toBeVisible();
  await expect(preview.locator("table")).toContainText("单元格");
  await expect(preview.locator("blockquote")).toContainText("引用内容");
  await expect(preview.locator("pre")).toContainText("fn main()");
  await preview.locator("td").filter({ hasText: "单元格" }).click();
  await expect
    .poll(() => page.evaluate(() => window.getSelection()?.toString()))
    .toContain("单元格");
  await preview.locator("pre").click();
  await expect
    .poll(() => page.evaluate(() => window.getSelection()?.toString()))
    .toContain("```rust");
  await page.screenshot({ path: testInfo.outputPath("preview-light.png") });
  const lightColor = await preview
    .locator("h1")
    .evaluate((element) => getComputedStyle(element).color);
  await page.evaluate(async () => {
    const url = "/src/lib/theme.ts";
    const { setTheme } = await import(url);
    await setTheme("dark");
  });
  await expect
    .poll(() =>
      preview
        .locator("h1")
        .evaluate((element) => getComputedStyle(element).color),
    )
    .not.toBe(lightColor);
  await page.screenshot({ path: testInfo.outputPath("preview-dark.png") });
  await page.setViewportSize({ width: 375, height: 812 });
  await expect(editor).toBeHidden();
  await expect(preview.locator("h1")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "预览", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByRole("button", { name: "分栏", exact: true }),
  ).toBeHidden();
  await page.screenshot({ path: testInfo.outputPath("preview-mobile.png") });
  await page.getByRole("button", { name: "源码", exact: true }).click();
  await expect(editor).toBeVisible();
  await expect(editor).toContainText("排版预览");
  await page.getByRole("button", { name: "预览", exact: true }).click();
  await expect(preview.locator("h1")).toHaveText("排版预览");
  await preview.locator("h1").click();
  await expect(editor).toBeFocused();
  await expect(preview).toHaveCount(0);
});
