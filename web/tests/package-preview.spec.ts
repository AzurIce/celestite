import { expect, test } from "@playwright/test";
import { packageFixture } from "./package-fixture";
import { installWorkerHarness, workerEvaluate } from "./worker-harness";

test.beforeEach(async ({ page }) => {
  await installWorkerHarness(page);
  await page.goto("/");
  await page.evaluate(
    async (files) => {
      const address = "/src/lib/vault/index.ts";
      const { openOpfsVault, vaultPath } = (await import(
        address
      )) as typeof import("../src/lib/vault");
      const vault = await openOpfsVault();
      for (const [path, data] of files) {
        const parent = path.slice(0, path.lastIndexOf("/"));
        if (path.includes("/"))
          await vault.mkdir(vaultPath(parent), { recursive: true });
        await vault.writeFile(vaultPath(path), new Uint8Array(data), {
          mode: "create",
        });
      }
      await vault.close();
    },
    packageFixture().map(
      ([path, data]) => [path, Array.from(data)] as [string, number[]],
    ),
  );
  await page.reload();
});

test("package components retain relative modules and streaming WASM with source mapping", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page
    .getByRole("treeitem", { name: "package.not", exact: true })
    .click();
  await page.getByRole("button", { name: "分栏", exact: true }).click();
  const preview = page.getByRole("region", { name: "文档预览" });
  await expect(preview.locator("demo-card strong")).toHaveText("默认标题");
  await expect(
    preview.locator("demo-card p").filter({ hasText: "WASM" }),
  ).toHaveText("相对 JS / WASM 42");
  await preview.locator("demo-card strong").click();
  await expect
    .poll(() => page.evaluate(() => window.getSelection()?.toString()))
    .toContain("#demo::card");
  await expect(
    page.getByRole("button", { name: "分栏", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  const editor = page.getByRole("textbox", { name: "代码编辑器" });
  await editor.focus();
  await page.keyboard.press("Control+a");
  await page.keyboard.insertText(
    '= Updated\n\n#demo::card(title: "新标题")[\n新正文\n]',
  );
  await expect(preview.locator("demo-card strong")).toHaveText("新标题");
  await expect(
    preview.locator("demo-card p").filter({ hasText: "WASM" }),
  ).toHaveText("相对 JS / WASM 42");
  await page.reload();
  await page
    .getByRole("treeitem", { name: "package.not", exact: true })
    .click();
  await page.getByRole("button", { name: "分栏", exact: true }).click();
  await expect(
    preview.locator("demo-card p").filter({ hasText: "WASM" }),
  ).toHaveText("相对 JS / WASM 42");
  expect(errors).toEqual([]);
});

test("unsaved declarations are used without preview reads saving them; project errors preserve the last HTML", async ({
  page,
}) => {
  await page
    .getByRole("treeitem", { name: "package.not", exact: true })
    .click();
  await page.getByRole("button", { name: "分栏", exact: true }).click();
  const preview = page.getByRole("region", { name: "文档预览" });
  await expect(preview.locator("demo-card strong")).toHaveText("默认标题");
  // Hold automatic saves while preserving the real editor, core and preview.
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
  await page
    .getByRole("treeitem", { name: "packages", exact: true })
    .getByRole("button", { name: "展开" })
    .click();
  await page
    .getByRole("treeitem", { name: "demo", exact: true })
    .getByRole("button", { name: "展开" })
    .click();
  await page.getByRole("treeitem", { name: "lib.notc", exact: true }).click();
  const editor = page.getByRole("textbox", { name: "代码编辑器" });
  await editor.focus();
  await page.keyboard.press("Control+a");
  await page.keyboard.insertText(
    'fn card(title: String = "未保存声明")[children: Content] -> Content;',
  );
  await page.getByRole("tab", { name: "package.not", exact: true }).click();
  await expect(preview.locator("demo-card strong")).toHaveText("未保存声明");
  const disk = await page.evaluate(async () => {
    const address = "/src/lib/vault/index.ts";
    const { openOpfsVault, vaultPath } = (await import(
      address
    )) as typeof import("../src/lib/vault");
    const vault = await openOpfsVault();
    const source = new TextDecoder().decode(
      await vault.readFile(vaultPath("packages/demo/lib.notc")),
    );
    await vault.close();
    return source;
  });
  expect(disk).toContain("默认标题");
  // Write through the real Worker service so the active project is invalidated.
  await page.evaluate(async () => {
    const { editorWorkers, editorMessages } = window as unknown as {
      editorWorkers: Worker[];
      editorMessages: { kind: string; sessionId: string }[];
    };
    const worker = editorWorkers[0];
    const sessionId = editorMessages.find(
      (message) => message.kind === "ready",
    )!.sessionId;
    await new Promise<void>((resolve, reject) => {
      const listener = (event: MessageEvent) => {
        if (event.data.kind !== "reply" || event.data.requestId !== -1) return;
        worker.removeEventListener("message", listener);
        if (event.data.error) reject(new Error(event.data.error.message));
        else resolve();
      };
      worker.addEventListener("message", listener);
      worker.postMessage({
        kind: "request",
        sessionId,
        requestId: -1,
        method: "file",
        params: {
          method: "writeFile",
          path: "Notist.toml",
          data: Array.from(new TextEncoder().encode("[broken")),
          options: { mode: "replace" },
        },
      });
    });
  });
  await expect(preview.getByRole("status", { name: "预览状态" })).toHaveText(
    "预览失败",
  );
  await expect(preview.locator("demo-card strong")).toHaveText("未保存声明");
  await preview.locator("summary").click();
  await preview
    .getByRole("button")
    .filter({ hasText: "Notist.toml:" })
    .first()
    .click();
  await expect(
    page.getByRole("tab", { name: "Notist.toml", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(editor).toContainText("[broken");
});

test("component implementation changes request a page refresh while declarations remain live", async ({
  page,
}) => {
  await page
    .getByRole("treeitem", { name: "package.not", exact: true })
    .click();
  await page.getByRole("button", { name: "分栏", exact: true }).click();
  const preview = page.getByRole("region", { name: "文档预览" });
  await expect(
    preview.locator("demo-card p").filter({ hasText: "WASM" }),
  ).toHaveText("相对 JS / WASM 42");
  for (const name of ["packages", "demo", "components", "card"])
    await page
      .getByRole("treeitem", { name, exact: true })
      .getByRole("button", { name: "展开" })
      .click();
  await page.getByRole("treeitem", { name: "style.js", exact: true }).click();
  const editor = page.getByRole("textbox", { name: "代码编辑器" });
  await editor.focus();
  await page.keyboard.press("Control+a");
  await page.keyboard.insertText('export const suffix = "更新后的 JS";');
  await page.keyboard.press("Control+s");
  await expect(page.getByRole("status", { name: "保存状态" })).toHaveText(
    "已保存",
  );
  await page.getByRole("tab", { name: "package.not", exact: true }).click();
  await expect(preview.getByRole("alert")).toContainText("请刷新页面");
  await page.reload();
  await page
    .getByRole("treeitem", { name: "package.not", exact: true })
    .click();
  await page.getByRole("button", { name: "分栏", exact: true }).click();
  await expect(
    preview.locator("demo-card p").filter({ hasText: "WASM" }),
  ).toHaveText("更新后的 JS / WASM 42");
});
