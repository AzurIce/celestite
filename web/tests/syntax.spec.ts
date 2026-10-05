import { expect, test } from "@playwright/test";
import { installWorkerHarness } from "./worker-harness";

test.beforeEach(async ({ page }) => {
  await installWorkerHarness(page);
  await page.goto("/");
  await page.evaluate(async () => {
    const { openOpfsVault, vaultPath } = await import(
      "/src/lib/vault/index.ts" as string
    );
    const vault = await openOpfsVault();
    for (const extension of ["md", "nmd", "notmd", "not", "notc"]) {
      const text =
        extension === "notc"
          ? "/* comment */\nfn 中文(value: String, block?: Bool = false) -> Content<block>;"
          : extension === "not"
            ? '= Heading\n\n😀中文 #badge(label: "hello", count: 42)[*content*]\n'
            : '# Heading\n\n😀中文 #badge(label: "hello", count: 42)[**bold** #inner[*italic*]]\n\n`#hidden()`\n';
      await vault.writeFile(
        vaultPath(`a.${extension}`),
        new TextEncoder().encode(text),
        { mode: "create" },
      );
    }
    await vault.writeFile(
      vaultPath("plain.txt"),
      new TextEncoder().encode("#plain()"),
      { mode: "create" },
    );
    await vault.close();
  });
  await page.reload();
});

test("all five frontends render actual query captures and restore them after switching tabs", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  for (const extension of ["md", "nmd", "notmd", "not", "notc", "md"]) {
    await page
      .getByRole("treeitem", { name: `a.${extension}`, exact: true })
      .click();
    const editor = page.getByRole("textbox", { name: "代码编辑器" });
    if (extension === "notc") {
      await expect(editor.locator('[data-syntax="keyword"]')).toHaveText("fn");
      await expect(editor.locator('[data-syntax="function"]')).toHaveText(
        "中文",
      );
      await expect(editor.locator('[data-syntax="type"]').first()).toHaveText(
        "String",
      );
    } else {
      await expect(
        editor.locator('[data-syntax="function.call"]').first(),
      ).toHaveText("badge");
      await expect(editor.locator('[data-syntax="number"]')).toHaveText("42");
      if (extension !== "not") {
        await expect(
          editor.locator('[data-syntax="function.call"]'),
        ).toHaveText(["badge", "inner"]);
        await expect(
          editor.locator('[data-syntax="text.strong"]'),
        ).toContainText("bold");
      }
    }
  }
  await page.getByRole("treeitem", { name: "plain.txt", exact: true }).click();
  await expect(page.locator(".cm-content [data-syntax]")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("typing and undo refresh highlights without stale ranges, and Markdown still folds", async ({
  page,
}) => {
  await page.getByRole("treeitem", { name: "a.md", exact: true }).click();
  const editor = page.getByRole("textbox", { name: "代码编辑器" });
  await expect(
    editor.locator('[data-syntax="function.call"]').first(),
  ).toHaveText("badge");
  await editor.fill("# Updated\n\n😁中文 #newcall(value: 123)[**changed**]\n");
  await expect(editor.locator('[data-syntax="function.call"]')).toHaveText(
    "newcall",
  );
  await expect(editor.locator('[data-syntax="number"]')).toHaveText("123");
  await editor.focus();
  await page.keyboard.press("Control+z");
  await expect(
    editor.locator('[data-syntax="function.call"]').first(),
  ).toHaveText("badge");
  await page.getByTitle("Fold line", { exact: true }).first().click();
  await expect(page.getByLabel("folded code")).toBeVisible();
});

test("grammar download failures leave the document editable", async ({
  page,
}) => {
  await page.route("**/notist*.wasm*", (route) => route.abort());
  await page.getByRole("treeitem", { name: "a.not", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("语法高亮加载失败");
  const editor = page.getByRole("textbox", { name: "代码编辑器" });
  await editor.fill("正文仍可编辑");
  await expect(editor).toHaveText("正文仍可编辑");
  await page.getByRole("treeitem", { name: "plain.txt", exact: true }).click();
  await expect(
    page.getByText("语法高亮加载失败", { exact: false }),
  ).toHaveCount(0);
});
