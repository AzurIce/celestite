import { expect, test, type Page } from "@playwright/test";
import { packageFixture } from "./package-fixture";
import { installWorkerHarness, workerEvaluate } from "./worker-harness";

async function setup(page: Page) {
  await installWorkerHarness(page);
  await page.addInitScript(() => {
    Object.assign(window, {
      scopeChoice: "workspace",
      showDirectoryPicker: async (options: { mode: string; id: string }) => {
        if (!navigator.userActivation.isActive)
          throw new Error("Picker lost user activation");
        const opfs = await navigator.storage.getDirectory();
        const workspace = await opfs.getDirectoryHandle("Resource Workspace");
        if (options.id === "celestite-vault") {
          if (options.mode !== "readwrite")
            throw new Error("Vault must request readwrite");
          return (
            await workspace.getDirectoryHandle("nested")
          ).getDirectoryHandle("Notes");
        }
        if (options.mode !== "read")
          throw new Error("Resources must request read only");
        const choice = (window as unknown as { scopeChoice: string })
          .scopeChoice;
        if (choice === "cancel")
          throw new DOMException("Cancelled", "AbortError");
        if (choice === "unrelated")
          return opfs.getDirectoryHandle("Unrelated", { create: true });
        return workspace;
      },
    });
  });
  await page.goto("/");
  const files = packageFixture().map(
    ([path, data]) =>
      [
        path.startsWith("packages/") ? path : `nested/Notes/${path}`,
        Array.from(
          path === "Notist.toml"
            ? new TextEncoder().encode(
                '[dependencies]\ndemo = { path = "../../packages/demo" }\n',
              )
            : data,
        ),
      ] as [string, number[]],
  );
  await page.evaluate(async (files) => {
    const workspace = await (
      await navigator.storage.getDirectory()
    ).getDirectoryHandle("Resource Workspace", { create: true });
    for (const [path, data] of files) {
      const parts = path.split("/");
      const name = parts.pop()!;
      let directory = workspace;
      for (const part of parts)
        directory = await directory.getDirectoryHandle(part, { create: true });
      const stream = await (
        await directory.getFileHandle(name, { create: true })
      ).createWritable();
      await stream.write(new Uint8Array(data));
      await stream.close();
    }
  }, files);
  await page.getByRole("button", { name: "管理 Vault", exact: true }).click();
  await page.getByRole("button", { name: "打开本机目录", exact: true }).click();
  await page
    .getByRole("treeitem", { name: "package.not", exact: true })
    .click();
  await page.getByRole("button", { name: "分栏", exact: true }).click();
  const preview = page.getByRole("region", { name: "文档预览" });
  await expect(preview.getByRole("status", { name: "预览状态" })).toHaveText(
    "预览失败",
  );
  await expect(
    preview.getByText("依赖超出当前授权范围", { exact: false }),
  ).toBeVisible();
  return preview;
}

test("a wider read grant loads sibling packages and WASM, preserving the Vault root, identity and history after reload", async ({
  page,
}) => {
  const preview = await setup(page);
  const id = await page
    .getByRole("combobox", { name: "当前 Vault" })
    .inputValue();
  await preview
    .getByRole("button", { name: "授权依赖目录", exact: true })
    .click();
  await expect(preview.locator("demo-card strong")).toHaveText("默认标题");
  await expect(
    preview.locator("demo-card p").filter({ hasText: "WASM" }),
  ).toHaveText("相对 JS / WASM 42");
  await expect(page.getByRole("combobox", { name: "当前 Vault" })).toHaveValue(
    id,
  );
  await page.getByRole("button", { name: "管理 Vault", exact: true }).click();
  await expect(
    page
      .getByRole("dialog")
      .getByText("本机目录 · Resource Workspace/nested/Notes", { exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByRole("treeitem", { name: "packages", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("treeitem", { name: "nested", exact: true }),
  ).toHaveCount(0);
  const editor = page.getByRole("textbox", { name: "代码编辑器" });
  await editor.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.insertText("\nSaved in original vault\n");
  await expect(editor).toContainText("Saved in original vault");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByRole("status", { name: "保存状态" })).toHaveText(
    "已保存",
  );
  const stored = await page.evaluate(async () => {
    const url = "/src/lib/vault/directory-registry.ts";
    const { IndexedDbDirectoryRegistry } = await import(url);
    const [record] = await new IndexedDbDirectoryRegistry().list();
    const relative = await record.resourceScope.resolve(record.handle);
    const content = await (
      await record.handle.getFileHandle("package.not")
    ).getFile();
    const entries = [];
    for await (const [name] of record.handle.entries()) entries.push(name);
    return { id: record.id, relative, content: await content.text(), entries };
  });
  expect(stored.id).toBe(id);
  expect(stored.relative).toEqual(["nested", "Notes"]);
  expect(stored.content).toContain("Saved in original vault");
  expect(stored.entries.sort()).toEqual(["Notist.toml", "package.not"]);
  await page.reload();
  await page.getByRole("button", { name: "管理 Vault", exact: true }).click();
  await expect(
    page
      .getByRole("dialog")
      .getByText("本机目录 · Resource Workspace/nested/Notes", { exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("combobox", { name: "当前 Vault" }).selectOption(id);
  await page
    .getByRole("treeitem", { name: "package.not", exact: true })
    .click();
  await page.getByRole("button", { name: "分栏", exact: true }).click();
  await expect(
    preview.locator("demo-card p").filter({ hasText: "WASM" }),
  ).toHaveText("相对 JS / WASM 42");
  await expect(page.getByRole("textbox", { name: "代码编辑器" })).toContainText(
    "Saved in original vault",
  );
});

test("cancelled and unrelated selections preserve the existing grant and current editor", async ({
  page,
}) => {
  const preview = await setup(page);
  await page.evaluate(() =>
    Object.assign(window, { scopeChoice: "unrelated" }),
  );
  await preview
    .getByRole("button", { name: "授权依赖目录", exact: true })
    .click();
  await expect(preview.getByRole("alert")).toContainText(
    "请选择包含当前 Vault 的目录",
  );
  await page.evaluate(() => Object.assign(window, { scopeChoice: "cancel" }));
  await preview
    .getByRole("button", { name: "授权依赖目录", exact: true })
    .click();
  await expect(
    preview.getByRole("button", { name: "授权依赖目录", exact: true }),
  ).toBeEnabled();
  await page.evaluate(() =>
    Object.assign(window, { scopeChoice: "workspace" }),
  );
  await preview
    .getByRole("button", { name: "授权依赖目录", exact: true })
    .click();
  await expect(preview.locator("demo-card strong")).toHaveText("默认标题");
  await page.evaluate(() =>
    Object.assign(window, { scopeChoice: "unrelated" }),
  );
  await preview
    .getByRole("button", { name: "授权依赖目录", exact: true })
    .click();
  await expect(preview.getByRole("alert")).toContainText(
    "请选择包含当前 Vault 的目录",
  );
  await expect(preview.locator("demo-card strong")).toHaveText("默认标题");
  await page.evaluate(() => Object.assign(window, { scopeChoice: "cancel" }));
  await preview
    .getByRole("button", { name: "授权依赖目录", exact: true })
    .click();
  await expect(preview.locator("demo-card strong")).toHaveText("默认标题");
});

test("unchanged directory checks never retry a failed preview; edits and explicit retry still dispatch", async ({
  page,
}) => {
  const preview = await setup(page);
  const taskId = () =>
    page.evaluate(() => {
      const messages = (
        window as unknown as {
          editorMessages: {
            kind: string;
            event?: { state?: { target: { taskId: string } } };
          }[];
        }
      ).editorMessages;
      return messages
        .filter((message) => message.kind === "preview" && message.event?.state)
        .at(-1)!.event!.state!.target.taskId;
    });
  const initial = await taskId();
  // Cross two actual foreground observation intervals, with focus hints as well.
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.waitForTimeout(6500);
  await expect(preview.getByRole("status", { name: "预览状态" })).toHaveText(
    "预览失败",
  );
  expect(await taskId()).toBe(initial);
  await preview.getByRole("button", { name: "重试预览", exact: true }).click();
  await expect.poll(taskId).not.toBe(initial);
  await expect(preview.getByRole("status", { name: "预览状态" })).toHaveText(
    "预览失败",
  );
  const retried = await taskId();
  const editor = page.getByRole("textbox", { name: "代码编辑器" });
  await editor.focus();
  await page.keyboard.press("Control+End");
  await page.keyboard.insertText("\nChanged source\n");
  await expect.poll(taskId).not.toBe(retried);
  await expect(preview.getByRole("status", { name: "预览状态" })).toHaveText(
    "预览失败",
  );
  await preview
    .getByRole("button", { name: "授权依赖目录", exact: true })
    .click();
  await expect(preview.locator("demo-card strong")).toHaveText("默认标题");
});

test("external declarations refresh on demand and lost resource permission leaves editing available", async ({
  page,
}) => {
  const preview = await setup(page);
  await preview
    .getByRole("button", { name: "授权依赖目录", exact: true })
    .click();
  await expect(preview.locator("demo-card strong")).toHaveText("默认标题");
  await page.evaluate(async () => {
    const workspace = await (
      await navigator.storage.getDirectory()
    ).getDirectoryHandle("Resource Workspace");
    const demo = await (
      await workspace.getDirectoryHandle("packages")
    ).getDirectoryHandle("demo");
    const stream = await (
      await demo.getFileHandle("lib.notc")
    ).createWritable();
    await stream.write(
      'fn card(title: String = "External declaration")[children: Content] -> Content;',
    );
    await stream.close();
    window.dispatchEvent(new Event("focus"));
  });
  await preview.getByRole("button", { name: "刷新预览", exact: true }).click();
  await expect(preview.locator("demo-card strong")).toHaveText(
    "External declaration",
  );
  await workerEvaluate(
    page,
    () => {
      const state = self as unknown as {
        originalGetFile: typeof FileSystemFileHandle.prototype.getFile;
      };
      state.originalGetFile = FileSystemFileHandle.prototype.getFile;
      FileSystemFileHandle.prototype.getFile = async function () {
        if (this.name === "lib.notc")
          throw new DOMException("Revoked", "NotAllowedError");
        return state.originalGetFile.call(this);
      };
    },
    undefined,
    1,
  );
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await preview.getByRole("button", { name: "刷新预览", exact: true }).click();
  await expect(preview.getByRole("status", { name: "预览状态" })).toHaveText(
    "预览失败",
  );
  await expect(preview.getByRole("alert")).toContainText("读取权限已失效");
  const editor = page.getByRole("textbox", { name: "代码编辑器" });
  await editor.focus();
  await page.keyboard.press("Control+End");
  await page.keyboard.insertText("\nStill editable\n");
  await page.keyboard.press("Control+s");
  await expect(page.getByRole("status", { name: "保存状态" })).toHaveText(
    "已保存",
  );
  await workerEvaluate(
    page,
    () => {
      FileSystemFileHandle.prototype.getFile = (
        self as unknown as {
          originalGetFile: typeof FileSystemFileHandle.prototype.getFile;
        }
      ).originalGetFile;
    },
    undefined,
    1,
  );
  await preview
    .getByRole("button", { name: "授权依赖目录", exact: true })
    .click();
  await expect(preview.locator("demo-card strong")).toHaveText(
    "External declaration",
  );
  await expect(editor).toContainText("Still editable");
  await page.evaluate(async () => {
    const workspace = await (
      await navigator.storage.getDirectory()
    ).getDirectoryHandle("Resource Workspace");
    const demo = await (
      await workspace.getDirectoryHandle("packages")
    ).getDirectoryHandle("demo");
    const card = await (
      await demo.getDirectoryHandle("components")
    ).getDirectoryHandle("card");
    const stream = await (
      await card.getFileHandle("style.js")
    ).createWritable();
    await stream.write('export const suffix = "Updated implementation";');
    await stream.close();
  });
  await preview.getByRole("button", { name: "刷新预览", exact: true }).click();
  await expect(preview.getByRole("alert")).toContainText("请刷新页面");
});

test("package capabilities validate containment, paths and resource size without exposing write operations", async ({
  page,
}) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const url = "/src/lib/editor/local/package-resources.ts";
    const { DirectoryPackageResources } = await import(url);
    const opfs = await navigator.storage.getDirectory();
    const scope = await opfs.getDirectoryHandle("capability-test", {
      create: true,
    });
    const vault = await scope.getDirectoryHandle("Vault", { create: true });
    const unrelated = await opfs.getDirectoryHandle("unrelated", {
      create: true,
    });
    const provider = await DirectoryPackageResources.open(scope, vault);
    const failures: string[] = [];
    for (const path of [
      "/outside/file",
      "/workspace-other/file",
      "/workspace/../file",
      "/workspace/a//file",
    ]) {
      try {
        await provider.read({ path, read: true });
      } catch (error) {
        failures.push((error as { code: string }).code);
      }
    }
    let unrelatedError = "";
    try {
      await DirectoryPackageResources.open(unrelated, vault);
    } catch (error) {
      unrelatedError = (error as Error).message;
    }
    const stream = await (
      await scope.getFileHandle("large", { create: true })
    ).createWritable();
    await stream.truncate(16 * 1024 * 1024 + 1);
    await stream.close();
    let largeError = "";
    try {
      await provider.read({ path: "/workspace/large", read: true });
    } catch (error) {
      largeError = (error as Error).message;
    }
    const absent = await provider.read({
      path: "/workspace/missing",
      read: true,
    });
    return {
      root: provider.root,
      failures,
      unrelatedError,
      largeError,
      absent,
      writable: "writeFile" in provider || "remove" in provider,
    };
  });
  expect(result).toEqual({
    root: "/workspace/Vault",
    failures: [
      "PermissionDenied",
      "PermissionDenied",
      "InvalidPath",
      "InvalidPath",
    ],
    unrelatedError: "请选择包含当前 Vault 的目录。",
    largeError: "预览资源超过 16 MiB。",
    absent: { kind: null, data: null, error: null },
    writable: false,
  });
});

test("a lost saved resource grant permits reopening the Vault and restores in its existing Worker after a new grant", async ({
  page,
}) => {
  const preview = await setup(page);
  const id = await page
    .getByRole("combobox", { name: "当前 Vault" })
    .inputValue();
  await preview
    .getByRole("button", { name: "授权依赖目录", exact: true })
    .click();
  await expect(preview.locator("demo-card strong")).toHaveText("默认标题");
  await page.route(
    "**/src/lib/editor/local/package-resources.ts*",
    async (route) => {
      const response = await route.fetch();
      await route.fulfill({
        response,
        body:
          (await response.text()) +
          `
      if (typeof window === "undefined") {
        self.denySavedResources = true;
        const query = FileSystemDirectoryHandle.prototype.queryPermission;
        FileSystemDirectoryHandle.prototype.queryPermission = function(options) {
          if (self.denySavedResources && this.name === "Resource Workspace") return Promise.resolve("denied");
          return query.call(this, options);
        };
      }
    `,
      });
    },
  );
  await page.reload();
  await page.getByRole("combobox", { name: "当前 Vault" }).selectOption(id);
  await page
    .getByRole("treeitem", { name: "package.not", exact: true })
    .click();
  await page.getByRole("button", { name: "分栏", exact: true }).click();
  await expect(preview.getByRole("status", { name: "预览状态" })).toHaveText(
    "预览失败",
  );
  await expect(page.getByRole("textbox", { name: "代码编辑器" })).toContainText(
    "组件中的正文",
  );
  await workerEvaluate(
    page,
    () => {
      Object.assign(self, { denySavedResources: false });
    },
    undefined,
    1,
  );
  await page
    .getByRole("combobox", { name: "当前 Vault" })
    .selectOption("opfs:default");
  await page.getByRole("combobox", { name: "当前 Vault" }).selectOption(id);
  await expect(preview.locator("demo-card strong")).toHaveText("默认标题");
  await expect(page.getByRole("combobox", { name: "当前 Vault" })).toHaveValue(
    id,
  );
});
