import { expect, test as base, type Page } from "@playwright/test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";

type Api = { url: string; root: string; token: string };
const binary =
  process.env.CELESTITE_SERVER_BIN ??
  fileURLToPath(
    new URL("../../target/debug/celestite-server", import.meta.url),
  );
const test = base.extend<{ runtimeErrors: string[] }, { api: Api }>({
  runtimeErrors: [
    async ({ page }, use) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await use(errors);
      expect(errors).toEqual([]);
    },
    { auto: true },
  ],
  api: [
    async ({}, use, workerInfo) => {
      if (!existsSync(binary))
        throw new Error(
          "Build the server first: cargo build -p celestite-server",
        );
      const root = await mkdtemp(join(tmpdir(), "celestite-e2e-"));
      const socket = createServer();
      await new Promise<void>((resolve) =>
        socket.listen(0, "127.0.0.1", resolve),
      );
      const port = (socket.address() as { port: number }).port;
      await new Promise<void>((resolve) => socket.close(() => resolve()));
      for (const id of ["notes", "work", "readonly"]) {
        await mkdir(join(root, id));
        await writeFile(join(root, id, "a.md"), `# ${id} original\n`);
      }
      await mkdir(join(root, "notes", ".celestite"));
      await writeFile(
        join(root, "notes", ".celestite", "settings.json"),
        '{"theme.mode":"dark"}',
      );
      const config = join(root, "config.toml");
      await writeFile(
        config,
        `[server]\nlisten = "127.0.0.1:${port}"\nallowed_origins = [${JSON.stringify(String(workerInfo.project.use.baseURL))}]\ntoken_env = "CELESTITE_E2E_TOKEN"\n\n` +
          ["notes", "work", "readonly"]
            .map(
              (id) =>
                `[[vaults]]\nid = "${id}"\nname = "${id}"\npath = "${id}"\nread_only = ${id === "readonly"}\n`,
            )
            .join("\n"),
      );
      const token = "browser-test-token";
      let child: ChildProcess | undefined;
      try {
        child = spawn(binary, ["--config", config], {
          env: { ...process.env, CELESTITE_E2E_TOKEN: token },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let errors = "";
        child.stderr?.on("data", (bytes) => (errors += String(bytes)));
        const url = `http://127.0.0.1:${port}/api/v1/vaults/notes`;
        for (let retry = 0; retry < 100; retry++) {
          if (child.exitCode !== null)
            throw new Error(`server exited: ${errors}`);
          try {
            const response = await fetch(url, {
              headers: { Authorization: `Bearer ${token}` },
            });
            if (response.ok) break;
          } catch {}
          if (retry === 99) throw new Error("server startup timed out");
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        await use({ url, root, token });
      } finally {
        child?.kill("SIGTERM");
        if (child && child.exitCode === null)
          await new Promise<void>((resolve) =>
            child!.once("exit", () => resolve()),
          );
        await rm(root, { recursive: true, force: true });
      }
    },
    { scope: "worker" },
  ],
});
async function connect(page: Page, url: string, token: string) {
  await page.getByRole("button", { name: "管理 Vault", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "管理 Vault", exact: true });
  await dialog.getByLabel("连接远端 Vault", { exact: true }).fill(url);
  await dialog.getByLabel("访问令牌（可选）", { exact: true }).fill(token);
  await dialog.getByRole("button", { name: "连接", exact: true }).click();
  await expect(dialog).not.toBeVisible();
}
async function seedLocal(page: Page) {
  await page.goto("/");
  await page.evaluate(async () => {
    const url = "/src/lib/vault/index.ts";
    const { openOpfsVault, vaultPath } = (await import(
      url
    )) as typeof import("../src/lib/vault");
    const backend = await openOpfsVault();
    await backend.mkdir(vaultPath("local-folder"));
    await backend.writeFile(
      vaultPath("a.md"),
      new TextEncoder().encode("# local original\n"),
      { mode: "create" },
    );
    await backend.close();
  });
  await page.goto("/");
  await expect(
    page.getByRole("treeitem", { name: "a.md", exact: true }),
  ).toBeVisible();
}
const editor = (page: Page) =>
  page.getByRole("textbox", { name: "代码编辑器", exact: true });

for (const intent of ["save", "close"] as const) {
  for (const action of ["overwrite", "discard"] as const) {
    test(`external conflict: ${intent} then ${action} preserves the chosen version`, async ({
      page,
      api,
    }) => {
      const name = `conflict-${intent}-${action}.md`;
      const disk = join(api.root, "work", name);
      await writeFile(disk, "original");
      await page.goto("/");
      await connect(page, api.url.replace(/notes$/, "work"), api.token);
      await page.getByRole("treeitem", { name, exact: true }).click();
      await expect(editor(page)).toHaveText("original");
      await writeFile(disk, "external version");
      await editor(page).fill("local draft");
      if (intent === "save") await page.keyboard.press("Control+s");
      else
        await page
          .getByRole("button", { name: `关闭 ${name}`, exact: true })
          .click();
      const dialog = page.getByRole("dialog", { name: "文件已在磁盘上修改" });
      await expect(dialog).toBeVisible();
      await expect(
        dialog.getByRole("button", { name: "取消", exact: true }),
      ).toBeFocused();
      await expect(dialog).toContainText(name);
      await dialog
        .getByRole("button", {
          name: action === "overwrite" ? "覆盖保存" : "丢弃编辑",
          exact: true,
        })
        .click();
      await expect(dialog).not.toBeVisible();
      const chosen =
        action === "overwrite" ? "local draft" : "external version";
      expect(await readFile(disk, "utf8")).toBe(chosen);
      if (intent === "close") {
        await expect(page.getByRole("tab", { name, exact: true })).toHaveCount(
          0,
        );
        await page.getByRole("treeitem", { name, exact: true }).click();
      }
      await expect(editor(page)).toHaveText(chosen);
      await expect(page.getByRole("status", { name: "保存状态" })).toHaveText(
        "已保存",
      );
      if (action === "discard") {
        await editor(page).focus();
        await page.keyboard.press("Control+z");
        await expect(editor(page)).toHaveText(chosen);
        await page
          .getByLabel("当前 Vault", { exact: true })
          .selectOption("opfs:default");
        await page
          .getByLabel("当前 Vault", { exact: true })
          .selectOption(`remote:${api.url.replace(/notes$/, "work")}`);
        await expect(editor(page)).toHaveText(chosen);
      }
      await editor(page).fill("next edit");
      await page.keyboard.press("Control+s");
      await expect(page.getByRole("status", { name: "保存状态" })).toHaveText(
        "已保存",
      );
      expect(await readFile(disk, "utf8")).toBe("next edit");
    });
  }
}

test("autosave conflict stays inline until requested, and Escape preserves edits", async ({
  page,
  api,
}) => {
  const name = "conflict-autosave.md";
  const disk = join(api.root, "work", name);
  await writeFile(disk, "original");
  await page.goto("/");
  await connect(page, api.url.replace(/notes$/, "work"), api.token);
  await page.getByRole("treeitem", { name, exact: true }).click();
  await expect(editor(page)).toHaveText("original");
  await writeFile(disk, "external");
  await editor(page).fill("local draft");
  await expect(page.getByRole("status", { name: "保存状态" })).toHaveText(
    "保存失败",
  );
  const dialog = page.getByRole("dialog", { name: "文件已在磁盘上修改" });
  await expect(dialog).not.toBeVisible();
  await page.getByRole("button", { name: "处理冲突", exact: true }).click();
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(editor(page)).toHaveText("local draft");
  expect(await readFile(disk, "utf8")).toBe("external");
  await page.getByRole("button", { name: `关闭 ${name}`, exact: true }).click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await expect(page.getByRole("tab", { name, exact: true })).toBeVisible();
  await expect(editor(page)).toHaveText("local draft");
});

test("remote editing persists to disk; switching preserves independent undo and project settings", async ({
  page,
  api,
}) => {
  await seedLocal(page);
  await page.getByRole("treeitem", { name: "a.md", exact: true }).click();
  await editor(page).fill("# local edited");
  await page.keyboard.press("Control+s");
  await expect(page.getByRole("status", { name: "保存状态" })).toHaveText(
    "已保存",
  );
  await page
    .getByRole("treeitem", { name: "local-folder", exact: true })
    .click();
  await connect(page, api.url, api.token);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByRole("treeitem", { name: "a.md", exact: true }).click();
  await expect(editor(page)).toContainText("notes original");
  await editor(page).fill("# remote edited 中文");
  await page.keyboard.press("Control+s");
  await expect(page.getByRole("status", { name: "保存状态" })).toHaveText(
    "已保存",
  );
  expect(await readFile(join(api.root, "notes", "a.md"), "utf8")).toBe(
    "# remote edited 中文",
  );
  await page
    .getByRole("combobox", { name: "当前 Vault" })
    .selectOption("opfs:default");
  await expect(editor(page)).toContainText("local edited");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(
    page.getByRole("treeitem", { name: "local-folder", exact: true }),
  ).toHaveAttribute("aria-expanded", "true");
  await editor(page).focus();
  await page.keyboard.press("Control+z");
  await expect(editor(page)).toContainText("local original");
  await page.keyboard.press("Control+s");
  await expect(page.getByRole("status", { name: "保存状态" })).toHaveText(
    "已保存",
  );
  await page
    .getByRole("combobox", { name: "当前 Vault" })
    .selectOption({ label: "notes" });
  await expect(editor(page)).toContainText("remote edited");
  await editor(page).focus();
  await page.keyboard.press("Control+z");
  await expect(editor(page)).toContainText("notes original");
  await page.keyboard.press("Control+s");
  await expect(page.getByRole("status", { name: "保存状态" })).toHaveText(
    "已保存",
  );
});

test("connection records survive reload without storing tokens; removing a connection keeps server files", async ({
  page,
  api,
}) => {
  await page.goto("/");
  await connect(page, api.url, api.token);
  await connect(page, api.url + "/", api.token);
  await expect(
    page.getByRole("combobox", { name: "当前 Vault" }).locator("option"),
  ).toHaveCount(2);
  const stored = await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const directory = await root.getDirectoryHandle("celestite");
    const file = await directory.getFileHandle("connections.json");
    return (await file.getFile()).text();
  });
  expect(stored).not.toContain(api.token);
  await page.reload();
  await expect(page.getByRole("combobox", { name: "当前 Vault" })).toHaveValue(
    "opfs:default",
  );
  await expect(
    page.getByRole("combobox", { name: "当前 Vault" }).locator("option"),
  ).toHaveCount(2);
  await page
    .getByRole("combobox", { name: "当前 Vault" })
    .selectOption({ label: "notes" });
  await expect(
    page.getByRole("alert").filter({ hasText: "连接失败" }),
  ).toBeVisible();
  await connect(page, api.url, api.token);
  await page.getByRole("button", { name: "管理 Vault", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "管理 Vault" });
  await expect(
    dialog.getByRole("button", { name: "移除连接 我的 Vault" }),
  ).toHaveCount(0);
  await dialog.getByRole("button", { name: "移除连接 notes" }).click();
  await dialog
    .getByRole("button", { name: "确认移除连接", exact: true })
    .click();
  await expect(dialog.getByRole("listitem")).toHaveCount(1);
  expect(await readFile(join(api.root, "notes", "a.md"), "utf8")).toContain(
    "notes",
  );
});

test("remote backend implements binary IO, directories, move conflicts, conditional saves and close", async ({
  page,
  api,
}) => {
  await page.goto("/");
  const result = await page.evaluate(
    async ({ url, token }) => {
      const moduleUrl = "/src/lib/vault/index.ts";
      const { openHttpVault, vaultPath } = (await import(
        moduleUrl
      )) as typeof import("../src/lib/vault");
      const { backend } = await openHttpVault(url, token);
      const p = vaultPath;
      const code = async (task: () => Promise<unknown>) => {
        try {
          await task();
          return "success";
        } catch (error) {
          return (error as { code: string }).code;
        }
      };
      await backend.mkdir(p("contract/a"), { recursive: true });
      await backend.writeFile(
        p("contract/a/binary"),
        new Uint8Array([0, 255, 128]),
        { mode: "create" },
      );
      const bytes = await backend.readFile(p("contract/a/binary"));
      const entries = [];
      for await (const entry of backend.readDir(p("contract/a")))
        entries.push(entry);
      const duplicate = await code(() =>
        backend.writeFile(p("contract/a/binary"), new Uint8Array([1]), {
          mode: "create",
        }),
      );
      await backend.rename(p("contract/a"), p("contract/moved"));
      await backend.writeFile(p("contract/moved/binary"), new Uint8Array([2]), {
        mode: "replace",
      });
      const other = await openHttpVault(url, token);
      await other.backend.readFile(p("contract/moved/binary"));
      await other.backend.writeFile(
        p("contract/moved/binary"),
        new Uint8Array([3]),
        { mode: "replace" },
      );
      const conflict = await code(() =>
        backend.writeFile(p("contract/moved/binary"), new Uint8Array([4]), {
          mode: "replace",
        }),
      );
      const nonempty = await code(() => backend.remove(p("contract")));
      await backend.remove(p("contract"), { recursive: true });
      const absent = await backend.stat(p("contract"));
      const root = await code(() => backend.remove(p(""), { recursive: true }));
      await other.backend.close();
      await backend.close();
      const closed = await code(() => backend.stat(p("")));
      return {
        bytes: Array.from(bytes),
        entries,
        duplicate,
        conflict,
        nonempty,
        absent,
        root,
        closed,
      };
    },
    { url: api.url, token: api.token },
  );
  expect(result).toEqual({
    bytes: [0, 255, 128],
    entries: [{ path: "contract/a/binary", kind: "file" }],
    duplicate: "AlreadyExists",
    conflict: "Conflict",
    nonempty: "DirectoryNotEmpty",
    absent: null,
    root: "InvalidPath",
    closed: "Closed",
  });
});

test("watch refreshes the tree after an external disk change, and read-only Vaults reject editing", async ({
  page,
  api,
}) => {
  await page.goto("/");
  await connect(page, api.url, api.token);
  await writeFile(join(api.root, "notes", "external.md"), "external");
  await expect(
    page.getByRole("treeitem", { name: "external.md", exact: true }),
  ).toBeVisible();
  await connect(page, api.url.replace("/notes", "/readonly"), api.token);
  await page.getByRole("treeitem", { name: "a.md", exact: true }).click();
  await expect(editor(page)).toHaveAttribute("contenteditable", "false");
  await expect(
    page.getByText("当前 Vault 只读。", { exact: true }),
  ).toBeVisible();
});

test("external edits cause a save conflict and removing that connection keeps the dirty buffer", async ({
  page,
  api,
}) => {
  await page.goto("/");
  await connect(page, api.url.replace("/notes", "/work"), api.token);
  await page.getByRole("treeitem", { name: "a.md", exact: true }).click();
  await expect(editor(page)).toContainText("work original");
  await writeFile(join(api.root, "work", "a.md"), "external version");
  // Reading for download must not update the still-open editor's save baseline.
  await page
    .getByRole("treeitem", { name: "a.md", exact: true })
    .locator(".tree-row")
    .first()
    .click({ button: "right" });
  const download = page.waitForEvent("download");
  await page.getByRole("menuitem", { name: "下载", exact: true }).click();
  await download;
  await editor(page).fill("my unsaved version");
  await page.keyboard.press("Control+s");
  const conflict = page.getByRole("dialog", { name: "文件已在磁盘上修改" });
  await expect(conflict).toBeVisible();
  await conflict.getByRole("button", { name: "取消", exact: true }).click();
  await expect(page.getByRole("status", { name: "保存状态" })).toHaveText(
    "保存失败",
  );
  await expect(editor(page)).toContainText("my unsaved version");
  expect(await readFile(join(api.root, "work", "a.md"), "utf8")).toBe(
    "external version",
  );
  await page.getByRole("button", { name: "管理 Vault", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "管理 Vault" });
  await dialog.getByRole("button", { name: "移除连接 work" }).click();
  await dialog
    .getByRole("button", { name: "确认移除连接", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toContainText("连接仍保留");
  await expect(dialog.getByRole("listitem")).toHaveCount(2);
});

test("mobile connection controls fit the viewport", async ({ page, api }) => {
  await page.setViewportSize({ width: 360, height: 640 });
  await page.goto("/");
  await connect(page, api.url, api.token);
  await page.getByRole("treeitem", { name: "a.md", exact: true }).click();
  await expect(editor(page)).toBeVisible();
  await page.getByRole("button", { name: "管理 Vault", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "管理 Vault" });
  const box = await dialog.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(16);
  expect(box!.width).toBeLessThanOrEqual(328);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("remote file-tree creation, folder rename and deletion coordinate editor buffers", async ({
  page,
  api,
}) => {
  await page.goto("/");
  await connect(page, api.url, api.token);
  await page.getByRole("button", { name: "新建文件夹", exact: true }).click();
  await page.getByRole("textbox", { name: "名称", exact: true }).fill("drafts");
  await page.getByRole("button", { name: "确认", exact: true }).click();
  await expect(
    page.getByRole("treeitem", { name: "drafts", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "新建文件", exact: true }).click();
  await page.getByRole("textbox", { name: "名称", exact: true }).fill("new.md");
  await page.getByRole("button", { name: "确认", exact: true }).click();
  await page.getByRole("treeitem", { name: "new.md", exact: true }).click();
  await editor(page).fill("before rename");
  await page
    .getByRole("treeitem", { name: "drafts", exact: true })
    .locator(".tree-row")
    .first()
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: "重命名…" }).click();
  await page
    .getByRole("textbox", { name: "名称", exact: true })
    .fill("renamed");
  await page.getByRole("button", { name: "确认", exact: true }).click();
  await expect(
    page.getByRole("tab", { name: "renamed/new.md", exact: true }),
  ).toBeVisible();
  expect(
    await readFile(join(api.root, "notes", "renamed", "new.md"), "utf8"),
  ).toBe("before rename");
  await editor(page).fill("after rename");
  await page.keyboard.press("Control+s");
  await expect(page.getByRole("status", { name: "保存状态" })).toHaveText(
    "已保存",
  );
  expect(
    await readFile(join(api.root, "notes", "renamed", "new.md"), "utf8"),
  ).toBe("after rename");
  await page
    .getByRole("treeitem", { name: "renamed", exact: true })
    .locator(".tree-row")
    .first()
    .click();
  await page.keyboard.press("Delete");
  await page
    .getByRole("dialog", { name: "删除 1 项", exact: true })
    .getByRole("button", { name: "删除", exact: true })
    .click();
  await expect(
    page.getByRole("treeitem", { name: "renamed", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("tab", { name: "renamed/new.md", exact: true }),
  ).toHaveCount(0);
});

async function openSyncDebug(
  page: Page,
  api: Api,
  path: string,
  token = api.token,
) {
  await page.goto("/debug/sync");
  await page.getByLabel("Vault URL", { exact: true }).fill(api.url);
  await page.getByLabel("访问令牌", { exact: true }).fill(token);
  await page.getByRole("button", { name: "连接 server", exact: true }).click();
  await page.getByLabel("调试文档", { exact: true }).selectOption(path);
  await page
    .getByRole("button", { name: "打开并重建实例", exact: true })
    .click();
  await expect(
    page
      .getByRole("region", { name: "实例 A", exact: true })
      .getByRole("textbox"),
  ).toHaveValue("A😀B");
  await expect(
    page.getByRole("button", { name: "同步全部", exact: true }),
  ).toBeEnabled();
}

test("sync debug runs three independent WASM cores, merges through host, and preserves personal undo", async ({
  page,
  api,
}) => {
  const path = `debug-${crypto.randomUUID()}.md`;
  await writeFile(join(api.root, "notes", path), "A😀B");
  await openSyncDebug(page, api, path);
  await page.getByRole("button", { name: "添加实例", exact: true }).click();
  const a = page.getByRole("region", { name: "实例 A", exact: true });
  const b = page.getByRole("region", { name: "实例 B", exact: true });
  const c = page.getByRole("region", { name: "实例 C", exact: true });
  await expect(c.getByRole("textbox")).toHaveValue("A😀B");
  await expect(
    page.getByRole("button", { name: "同步全部", exact: true }),
  ).toBeEnabled();
  await a.getByRole("textbox").fill("A😀aB");
  await b.getByRole("textbox").fill("A😀bB");
  await expect(
    page.getByRole("button", { name: "同步全部", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "同步全部", exact: true }).click();
  await expect(page.getByRole("status", { name: "收敛状态" })).toHaveText(
    "因果版本已收敛",
  );
  const merged = await a.getByRole("textbox").inputValue();
  expect(merged).toContain("a");
  expect(merged).toContain("b");
  for (const region of [b, c])
    await expect(region.getByRole("textbox")).toHaveValue(merged);
  expect(await readFile(join(api.root, "notes", path), "utf8")).toBe("A😀B");
  await a.getByRole("button", { name: "撤销", exact: true }).click();
  await expect(a.getByRole("textbox")).toHaveValue("A😀bB");
  await page.getByRole("button", { name: "同步全部", exact: true }).click();
  await expect(page.getByRole("status", { name: "收敛状态" })).toHaveText(
    "因果版本已收敛",
  );
  for (const region of [a, b, c])
    await expect(region.getByRole("textbox")).toHaveValue("A😀bB");
  await page.getByRole("button", { name: "保存到文件", exact: true }).click();
  await expect(page.getByRole("status", { name: "Host 保存状态" })).toHaveText(
    "文件与正文一致",
  );
  expect(await readFile(join(api.root, "notes", path), "utf8")).toBe("A😀bB");
  await expect(page.getByRole("region", { name: "同步日志" })).toContainText(
    "host 历史仅驻留内存",
  );
});

test("sync debug keeps paused and failed transfers in memory and resumes explicit synchronization", async ({
  page,
  api,
}) => {
  const path = `debug-fault-${crypto.randomUUID()}.md`;
  await writeFile(join(api.root, "notes", path), "A😀B");
  await openSyncDebug(page, api, path);
  const a = page.getByRole("region", { name: "实例 A", exact: true });
  const b = page.getByRole("region", { name: "实例 B", exact: true });
  await b.getByRole("button", { name: "暂停传输", exact: true }).click();
  await a.getByRole("textbox").fill("A😀oneB");
  await page.getByRole("button", { name: "同步全部", exact: true }).click();
  await expect(
    page
      .getByRole("region", { name: "Host", exact: true })
      .getByRole("textbox"),
  ).toHaveValue("A😀oneB");
  await expect(b.getByRole("textbox")).toHaveValue("A😀B");
  await b.getByRole("textbox").fill("A😀twoB");
  await b.getByRole("button", { name: "恢复传输", exact: true }).click();
  const pattern = `${api.url}/documents/**`;
  await page.route(pattern, (route) => route.abort());
  await b.getByRole("button", { name: "推送", exact: true }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(b.getByRole("textbox")).toHaveValue("A😀twoB");
  await page.unroute(pattern);
  await page.getByRole("button", { name: "同步全部", exact: true }).click();
  await expect(page.getByRole("status", { name: "收敛状态" })).toHaveText(
    "因果版本已收敛",
  );
  const merged = await a.getByRole("textbox").inputValue();
  expect(merged).toContain("one");
  expect(merged).toContain("two");
  await expect(b.getByRole("textbox")).toHaveValue(merged);
});

test("sync debug honors bearer authentication and read-only vaults", async ({
  page,
  api,
}) => {
  const path = `debug-readonly-${crypto.randomUUID()}.md`;
  await writeFile(join(api.root, "readonly", path), "A😀B");
  await page.goto("/debug/sync");
  await page
    .getByLabel("Vault URL", { exact: true })
    .fill(api.url.replace("/notes", "/readonly"));
  await page.getByRole("button", { name: "连接 server", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("PermissionDenied");
  await page.getByLabel("访问令牌", { exact: true }).fill(api.token);
  await page.getByRole("button", { name: "连接 server", exact: true }).click();
  await page.getByLabel("调试文档", { exact: true }).selectOption(path);
  await page
    .getByRole("button", { name: "打开并重建实例", exact: true })
    .click();
  const a = page.getByRole("region", { name: "实例 A", exact: true });
  await expect(a.getByRole("textbox")).toHaveValue("A😀B");
  await expect(a.getByRole("textbox")).not.toBeEditable();
  await expect(
    a.getByRole("button", { name: "推送", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "保存到文件", exact: true }),
  ).toBeDisabled();
  await expect(
    a.getByRole("button", { name: "拉取", exact: true }),
  ).toBeEnabled();
});

test("sync debug retains textarea focus during rapid input and automatically converges without saving files", async ({
  page,
  api,
}) => {
  const path = `debug-auto-${crypto.randomUUID()}.md`;
  await writeFile(join(api.root, "notes", path), "A😀B");
  await openSyncDebug(page, api, path);
  const a = page
    .getByRole("region", { name: "实例 A", exact: true })
    .getByRole("textbox");
  const b = page
    .getByRole("region", { name: "实例 B", exact: true })
    .getByRole("textbox");
  await a.focus();
  await page.keyboard.press("End");
  await a.pressSequentially("+stream", { delay: 20 });
  await expect(a).toBeFocused();
  await expect(a).toHaveValue("A😀B+stream");
  const automatic = page.getByRole("checkbox", {
    name: "每秒同步",
    exact: true,
  });
  await automatic.check();
  await expect(b).toHaveValue("A😀B+stream", { timeout: 10000 });
  await expect(page.getByRole("status", { name: "收敛状态" })).toHaveText(
    "因果版本已收敛",
  );
  await automatic.uncheck();
  expect(await readFile(join(api.root, "notes", path), "utf8")).toBe("A😀B");
});
