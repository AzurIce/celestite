import { expect, test as base, type Page } from "@playwright/test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";

import { installWorkerHarness, workerEvaluate } from "./worker-harness";
import { packageFixture } from "./package-fixture";

type Api = { url: string; root: string; urls: Record<string, string> };
const binary =
  process.env.CELESTITE_SERVER_BIN ??
  fileURLToPath(
    new URL("../../target/debug/celestite-server", import.meta.url),
  );
function startupLinks(log: string) {
  const line = log
    .split("\n")
    .find(
      (line) =>
        line.includes("Vault share links") && line.includes("readonly_url="),
    );
  const readonly = line?.match(/readonly_url=(\S+)/)?.[1];
  const edit = line?.match(/edit_url=(\S+)/)?.[1];
  expect(readonly, "readonly link is printed at startup").toBeTruthy();
  expect(edit, "edit link is printed at startup").toBeTruthy();
  return { readonly: readonly!, edit: edit! };
}
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
      for (const id of ["notes", "work", "readonly"]) {
        await mkdir(join(root, id));
        await writeFile(join(root, id, "a.md"), `# ${id} original\n`);
      }
      await mkdir(join(root, "notes", ".celestite"));
      await writeFile(
        join(root, "notes", ".celestite", "settings.json"),
        '{"theme.mode":"dark"}',
      );
      const children: ChildProcess[] = [];
      try {
        const urls: Record<string, string> = {};
        for (const id of ["notes", "work", "readonly"]) {
          const config = join(root, `${id}.toml`);
          await writeFile(
            config,
            `[server]\nlisten = "127.0.0.1:0"\nallowed_origins = [${JSON.stringify(String(workerInfo.project.use.baseURL))}]\n\n[vault]\nname = "${id}"\npath = "${id}"\nread_only = ${id === "readonly"}\n`,
          );
          const child = spawn(binary, ["--config", config], {
            stdio: ["ignore", "pipe", "pipe"],
          });
          children.push(child);
          let log = "";
          child.stderr?.on("data", (bytes) => (log += String(bytes)));
          await expect
            .poll(
              () => {
                if (child.exitCode !== null || child.signalCode !== null)
                  throw new Error(`server exited: ${log}`);
                return log.includes("Celestite server listening");
              },
              { timeout: 10000 },
            )
            .toBe(true);
          const links = startupLinks(log);
          urls[id] = id === "readonly" ? links.readonly : links.edit;
          if (id === "notes") urls.reader = links.readonly;
        }
        await use({ url: urls.notes, root, urls });
      } finally {
        await Promise.all(
          children.map(async (child) => {
            if (child.exitCode !== null || child.signalCode !== null) return;
            await new Promise<void>((resolve) => {
              const timeout = setTimeout(() => child.kill("SIGKILL"), 5000);
              child.once("exit", () => {
                clearTimeout(timeout);
                resolve();
              });
              child.kill("SIGTERM");
            });
          }),
        );
        await rm(root, { recursive: true, force: true });
      }
    },
    { scope: "worker" },
  ],
});
async function connect(page: Page, url: string) {
  await page.getByRole("button", { name: "管理 Vault", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "管理 Vault", exact: true });
  await dialog.getByLabel("连接远端 Vault", { exact: true }).fill(url);
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
const editor = (page: Page) => page.locator(".cm-content");

test("external diff failures stay online, pause saving and can be retried", async ({
  page,
  api,
}) => {
  const name = "observation-stall.txt";
  const disk = join(api.root, "work", name);
  const original = "a".repeat(40_000);
  const content = () =>
    editor(page).evaluate(
      (element) =>
        (element as any).cmTile.root.view.state.doc.toString() as string,
    );
  await writeFile(disk, original);
  await page.goto("/");
  await connect(page, api.urls.work);
  await page.getByRole("treeitem", { name, exact: true }).click();
  await expect.poll(async () => (await content()).length).toBe(original.length);
  // A long line with no shared scalars exhausts the fixed compute budget.
  await writeFile(disk, "b".repeat(40_000));
  await expect(page.getByText(/外部修改尚未同步，自动写回已暂停/)).toBeVisible({
    timeout: 12_000,
  });
  await expect(
    page.getByRole("button", { name: "保存", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "尝试重新连接", exact: true }),
  ).not.toBeVisible();
  await expect.poll(async () => (await content()).length).toBe(original.length);
  await page.getByRole("button", { name: "重试同步", exact: true }).click();
  await expect(
    page.getByText("正在同步磁盘中的外部修改，完成后可保存。", { exact: true }),
  ).toBeVisible();
  // New input supersedes the running retry; its late timeout must not replace
  // the new status or commit the obsolete all-b branch.
  await writeFile(disk, original + " recovered");
  await expect
    .poll(async () => (await content()).endsWith(" recovered"), {
      timeout: 12_000,
    })
    .toBe(true);
  await expect(
    page.getByRole("button", { name: "重试同步", exact: true }),
  ).not.toBeVisible();
  await expect(
    page.getByText("正在同步磁盘中的外部修改，完成后可保存。", { exact: true }),
  ).not.toBeVisible();
  await expect(
    page.getByRole("button", { name: "尝试重新连接", exact: true }),
  ).not.toBeVisible();
  expect(await readFile(disk, "utf8")).toBe(original + " recovered");
});

for (const intent of ["save", "close"] as const) {
  test(`filesystem changes merge into collaborative history and ${intent} preserves save semantics`, async ({
    page,
    api,
  }) => {
    const name = `bridge-${intent}.md`;
    const disk = join(api.root, "work", name);
    await writeFile(disk, "original");
    await page.goto("/");
    await connect(page, api.urls.work);
    await page.getByRole("treeitem", { name, exact: true }).click();
    await expect(editor(page)).toHaveText("original");
    await editor(page).focus();
    await page.keyboard.press("Control+End");
    await page.keyboard.insertText("-client");
    await expect
      .poll(
        async () =>
          (await hostDocuments(api, "work")).find((d) => d.path === name)
            ?.snapshot.text,
      )
      .toBe("original-client");
    await writeFile(disk, "disk:original");
    await expect(editor(page)).toHaveText("disk:original-client");
    if (intent === "save") await page.keyboard.press("Control+s");
    else
      await page
        .getByRole("button", { name: `关闭 ${name}`, exact: true })
        .click();
    await expect
      .poll(() => readFile(disk, "utf8"))
      .toBe(intent === "save" ? "disk:original-client" : "disk:original");
    if (intent === "close") {
      await page.getByRole("treeitem", { name, exact: true }).click();
      await expect(editor(page)).toHaveText("disk:original-client");
    }
    await expect(
      page.getByRole("dialog", { name: "文件已在磁盘上修改" }),
    ).not.toBeVisible();
  });
}
async function hostDocuments(
  api: Api,
  vault = "notes",
): Promise<{ id: string; path: string; snapshot: { text: string } }[]> {
  const response = await fetch(api.urls[vault] + "/api/v1/documents");
  return response.json();
}
test("collaborative input commits history immediately while disk save stays explicit", async ({
  page,
  api,
}) => {
  const name = "explicit-save.md";
  const disk = join(api.root, "notes", name);
  await writeFile(disk, "original");
  await page.goto("/");
  await connect(page, api.url);
  await page.getByRole("treeitem", { name, exact: true }).click();
  await editor(page).fill("live history");
  await expect
    .poll(
      async () =>
        (await hostDocuments(api)).find((d) => d.path === name)?.snapshot.text,
    )
    .toBe("live history");
  const downloaded = page.waitForEvent("download");
  await page
    .getByRole("treeitem", { name, exact: true })
    .locator(".tree-row")
    .first()
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: "下载", exact: true }).click();
  const download = await downloaded;
  expect(await readFile((await download.path())!, "utf8")).toBe("original");
  // The synchronized host text does not imply a physical-file save.
  await expect(page.getByRole("status", { name: "保存状态" })).toHaveText(
    "未保存",
  );
  expect(await readFile(disk, "utf8")).toBe("original");
  await page.keyboard.press("Control+s");
  await expect.poll(() => readFile(disk, "utf8")).toBe("live history");
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
  await connect(page, api.url);
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

test("remote core previews unsaved Markdown and Notist with split mapping, scrolling and relative links", async ({
  page,
  api,
}, testInfo) => {
  const name = "remote-preview.md";
  const source =
    "# Remote initial\n\n[go to Notist](remote-note.not#dest)\n\n" +
    Array.from(
      { length: 60 },
      (_, i) =>
        `## Remote Section ${i}\n\n😀 中文 &amp; **bold** ${"paragraph ".repeat(30)}\n\n` +
        (i % 4 === 0
          ? '| X | Y |\n| --- | --- |\n| a | b |\n\n```rust\nprintln!("remote");\n```\n\n'
          : ""),
    ).join("");
  await writeFile(join(api.root, "notes", name), source);
  await writeFile(
    join(api.root, "notes", "remote-note.not"),
    '@(id: "dest")\n= 远端 Notist\n\n😀中文 #unknown[ok]',
  );
  await page.goto("/");
  await connect(page, api.url);
  await page.getByRole("treeitem", { name, exact: true }).click();
  await page.getByRole("button", { name: "分栏", exact: true }).click();
  const preview = page.getByRole("region", { name: "文档预览" });
  await expect(preview.locator("h1")).toHaveText("Remote initial");
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page
    .context()
    .route(api.url + "/api/v1/documents/*/client-commit", async (route) => {
      await blocked;
      await route.continue();
    });
  try {
    await editor(page).focus();
    await page.keyboard.press("Control+Home");
    await page.keyboard.press("Home");
    await page.keyboard.press("Shift+End");
    await page.keyboard.insertText("# Remote draft");
    await expect(preview.locator("h1")).toHaveText("Remote draft");
    expect(await readFile(join(api.root, "notes", name), "utf8")).toBe(source);
    await preview.locator("h2").first().click();
    await expect(editor(page)).toBeFocused();
    await expect
      .poll(() => page.evaluate(() => window.getSelection()?.toString()))
      .toContain("Remote Section 0");
    await expect(
      page.getByRole("button", { name: "分栏", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await page
      .locator(".cm-line")
      .filter({ hasText: /^## Remote Section 0$/ })
      .click({ position: { x: 70, y: 8 } });
    await expect(preview.locator("[data-notist-sync-target]")).toContainText(
      "Remote Section 0",
    );
    await page.locator(".cm-scroller").evaluate((element) => {
      element.dispatchEvent(new WheelEvent("wheel", { deltaY: 1500 }));
      element.scrollTop += 1500;
    });
    await expect
      .poll(() =>
        preview
          .locator(".preview-scroller")
          .evaluate((element) => element.scrollTop),
      )
      .toBeGreaterThan(500);
    const previous = await page
      .locator(".cm-scroller")
      .evaluate((element) => element.scrollTop);
    await preview.locator(".preview-scroller").evaluate((element) => {
      element.dispatchEvent(new WheelEvent("wheel", { deltaY: 2000 }));
      element.scrollTop += 2000;
    });
    await expect
      .poll(() =>
        page.locator(".cm-scroller").evaluate((element) => element.scrollTop),
      )
      .toBeGreaterThan(previous + 500);
    await page.screenshot({
      path: testInfo.outputPath("remote-split-preview.png"),
    });
  } finally {
    release();
  }
  await page.keyboard.press("Control+s");
  await expect(page.getByRole("status", { name: "保存状态" })).toHaveText(
    "已保存",
  );
  expect(await readFile(join(api.root, "notes", name), "utf8")).toContain(
    "# Remote draft",
  );
  await expect(preview.getByRole("status", { name: "预览状态" })).toHaveText(
    "预览已更新",
  );
  await preview.getByRole("link", { name: "go to Notist" }).click();
  await expect(preview.locator("h1")).toHaveText("远端 Notist");
  await expect(preview.locator(".notist-custom")).toContainText("ok");
  await preview.locator(".notist-custom").click();
  await expect(editor(page)).toBeFocused();
  await expect
    .poll(() => page.evaluate(() => window.getSelection()?.toString()))
    .toContain("ok");
});

test("remote packages load JS and WASM and invalidate on declaration changes without editing the document", async ({
  page,
  api,
}) => {
  for (const [path, data] of packageFixture("packaged/")) {
    const target = join(api.root, "notes", path);
    await mkdir(target.slice(0, target.lastIndexOf("/")), { recursive: true });
    await writeFile(target, data);
  }
  await page.goto("/");
  await connect(page, api.url);
  await page
    .getByRole("treeitem", { name: "packaged", exact: true })
    .getByRole("button", { name: "展开" })
    .click();
  await page
    .getByRole("treeitem", { name: "package.not", exact: true })
    .click();
  await page.getByRole("button", { name: "分栏", exact: true }).click();
  const preview = page.getByRole("region", { name: "文档预览" });
  await expect(preview.locator("demo-card strong")).toHaveText("默认标题");
  await expect(
    preview.locator("demo-card p").filter({ hasText: "WASM" }),
  ).toHaveText("相对 JS / WASM 42");
  const declaration = join(
    api.root,
    "notes",
    "packaged/packages/demo/lib.notc",
  );
  await writeFile(
    declaration,
    'fn card(title: String = "远端声明更新")[children: Content] -> Content;',
  );
  await expect(preview.locator("demo-card strong")).toHaveText("远端声明更新");
  await writeFile(declaration, "fn card(");
  await expect(preview.getByRole("status", { name: "预览状态" })).toHaveText(
    "预览失败",
  );
  await expect(preview.locator("demo-card strong")).toHaveText("远端声明更新");
  await preview.locator("summary").click();
  await preview
    .getByRole("button")
    .filter({ hasText: "packaged/packages/demo/lib.notc:" })
    .first()
    .click();
  await expect(
    page.getByRole("tab", {
      name: "packaged/packages/demo/lib.notc",
      exact: true,
    }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(editor(page)).toHaveText("fn card(");
});

test("recursive external packages remain outside the Vault and update the preview without entering history", async ({
  page,
  api,
}) => {
  for (const [path, data] of packageFixture()) {
    const target = path.startsWith("packages/")
      ? join(api.root, path.replace("packages/", "external-packages/"))
      : join(api.root, "work", path === "package.not" ? "external.not" : path);
    await mkdir(target.slice(0, target.lastIndexOf("/")), { recursive: true });
    await writeFile(
      target,
      path === "Notist.toml"
        ? '[dependencies]\nbridge = {path = "../external-packages/bridge"}\n'
        : data,
    );
  }
  const bridge = join(api.root, "external-packages/bridge");
  await mkdir(bridge, { recursive: true });
  await writeFile(
    join(bridge, "Notist.toml"),
    '[package]\nname = "bridge"\n[dependencies]\ndemo = {path = "../demo"}\n',
  );
  await writeFile(join(bridge, "lib.notc"), "fn unused() -> Content;");
  await page.goto("/");
  await connect(page, api.urls.work);
  await page
    .getByRole("treeitem", { name: "external.not", exact: true })
    .click();
  await page.getByRole("button", { name: "分栏", exact: true }).click();
  const preview = page.getByRole("region", { name: "文档预览" });
  await expect(preview.locator("demo-card strong")).toHaveText("默认标题");
  await expect(
    preview.locator("demo-card p").filter({ hasText: "WASM" }),
  ).toHaveText("相对 JS / WASM 42");
  expect(
    (await hostDocuments(api, "work")).some(
      (doc) =>
        doc.path.includes("external-packages") || doc.path.endsWith("lib.notc"),
    ),
  ).toBe(false);
  await expect(
    page.getByRole("treeitem", { name: "external-packages", exact: true }),
  ).toHaveCount(0);
  const declaration = join(api.root, "external-packages/demo/lib.notc");
  await writeFile(
    declaration,
    'fn card(title: String = "外部声明更新")[children: Content] -> Content;',
  );
  await expect(preview.locator("demo-card strong")).toHaveText("外部声明更新");
  await writeFile(declaration, "fn card(");
  await expect(preview.getByRole("status", { name: "预览状态" })).toHaveText(
    "预览失败",
  );
  await expect(preview.locator("demo-card strong")).toHaveText("外部声明更新");
  await preview.locator("summary").click();
  await preview
    .getByRole("button")
    .filter({ hasText: "/external-packages/demo/lib.notc:" })
    .first()
    .click();
  await expect(
    preview.getByRole("region", { name: "package 诊断源码" }),
  ).toContainText("fn card(");
  await expect(
    page.getByRole("tab", { name: "external.not", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await writeFile(
    declaration,
    'fn card(title: String = "声明恢复")[children: Content] -> Content;',
  );
  await expect(preview.locator("demo-card strong")).toHaveText("声明恢复");
  await writeFile(
    join(api.root, "external-packages/demo/Notist.toml"),
    "[package",
  );
  await expect(preview.getByRole("status", { name: "预览状态" })).toHaveText(
    "预览失败",
  );
  await expect(preview.locator("demo-card strong")).toHaveText("声明恢复");
  await preview.locator("summary").click();
  await preview
    .getByRole("button")
    .filter({ hasText: "/external-packages/demo/Notist.toml:" })
    .first()
    .click();
  await expect(
    preview.getByRole("region", { name: "package 诊断源码" }),
  ).toContainText("[package");
});

test("connection records restore share credentials on reload; removing a connection keeps server files", async ({
  page,
  api,
}) => {
  await page.goto("/");
  await connect(page, api.url);
  await connect(page, api.url + "/");
  await expect(
    page.getByRole("combobox", { name: "当前 Vault" }).locator("option"),
  ).toHaveCount(2);
  const stored = await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const directory = await root.getDirectoryHandle("celestite");
    const file = await directory.getFileHandle("connections.json");
    return (await file.getFile()).text();
  });
  expect(stored).toContain(api.url);
  expect(JSON.parse(stored).version).toBe(2);
  expect(JSON.parse(stored).connections[0].id).not.toContain(api.url);
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
    page.getByRole("treeitem", { name: "a.md", exact: true }),
  ).toBeVisible();
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
    async ({ url }) => {
      const moduleUrl = "/src/lib/vault/index.ts";
      const { openHttpVault, vaultPath } = (await import(
        moduleUrl
      )) as typeof import("../src/lib/vault");
      const { backend } = await openHttpVault(url);
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
      const other = await openHttpVault(url);
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
    { url: api.url },
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
  await connect(page, api.url);
  await writeFile(join(api.root, "notes", "external.md"), "external");
  await expect(
    page.getByRole("treeitem", { name: "external.md", exact: true }),
  ).toBeVisible();
  await connect(page, api.urls.readonly);
  await page.getByRole("treeitem", { name: "a.md", exact: true }).click();
  await expect(editor(page)).toHaveAttribute("contenteditable", "false");
  await expect(
    page.getByText("当前 Vault 只读。", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "分栏", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "文档预览" }).locator("h1"),
  ).toHaveText("readonly original");
  await expect(editor(page)).toHaveAttribute("contenteditable", "false");
});

test("startup readonly and edit links to one Vault synchronize with separate permissions", async ({
  page,
  api,
}) => {
  const name = "share-collaboration.md";
  await writeFile(join(api.root, "notes", name), "# Initial");
  const reader = await page.context().newPage();
  const readerUrl = api.urls.reader;
  try {
    await page.goto("/");
    await connect(page, api.url);
    await page.getByRole("treeitem", { name, exact: true }).click();
    await reader.goto("/");
    await connect(reader, readerUrl);
    await reader.getByRole("treeitem", { name, exact: true }).click();
    await expect(editor(reader)).toHaveAttribute("contenteditable", "false");
    await reader.getByRole("button", { name: "分栏", exact: true }).click();
    await expect(
      reader.getByRole("region", { name: "文档预览" }).locator("h1"),
    ).toHaveText("Initial");
    await editor(page).fill("# Shared update");
    await expect(editor(reader)).toHaveText("# Shared update");
    await expect(
      reader.getByRole("region", { name: "文档预览" }).locator("h1"),
    ).toHaveText("Shared update");
    await expect(editor(page)).toHaveAttribute("contenteditable", "true");
    expect(
      (await fetch(readerUrl.replace("/ro-", "/") + "/api/v1")).status,
    ).toBe(404);
    const denied = await fetch(
      readerUrl + "/api/v1/file?path=" + name + "&mode=replace",
      { method: "PUT", body: "forged write" },
    );
    expect(denied.status).toBe(403);
    await page.keyboard.press("Control+s");
    await expect
      .poll(() => readFile(join(api.root, "notes", name), "utf8"))
      .toBe("# Shared update");
    await expect(editor(reader)).toHaveText("# Shared update");
  } finally {
    await reader.close();
  }
});

test("changing share_key and restarting replaces startup links and begins new Vault history", async ({
  page,
  baseURL,
}) => {
  const root = await mkdtemp(join(tmpdir(), "celestite-rotation-"));
  const reservation = createServer();
  await new Promise<void>((resolve) =>
    reservation.listen(0, "127.0.0.1", resolve),
  );
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const config = join(root, "config.toml");
  const configuration = (key: string) =>
    `[server]\nlisten = "127.0.0.1:${port}"\nallowed_origins = [${JSON.stringify(baseURL)}]\n\n[vault]\nname = "notes"\npath = "notes"\nshare_key = "${key}"\n`;
  let child: ChildProcess | undefined;
  const stop = async () => {
    if (!child || child.exitCode !== null) return;
    const process = child;
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => process.kill("SIGKILL"), 5000);
      process.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
      process.kill("SIGTERM");
    });
    child = undefined;
  };
  const start = async () => {
    let log = "";
    child = spawn(binary, ["--config", config], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr?.on("data", (bytes) => (log += String(bytes)));
    await expect
      .poll(() => {
        if (child!.exitCode !== null) throw new Error(`server exited: ${log}`);
        return log.includes("readonly_url=");
      })
      .toBe(true);
    return startupLinks(log);
  };
  try {
    await mkdir(join(root, "notes"));
    await writeFile(join(root, "notes", "a.md"), "# Original");
    await writeFile(
      config,
      configuration("random configuration secret value old 1234567890"),
    );
    const before = await start();
    const identity = (await (await fetch(before.edit + "/api/v1")).json())
      .vaultIdentity;
    await page.goto("/");
    await connect(page, before.edit);
    await page.getByRole("treeitem", { name: "a.md", exact: true }).click();
    await editor(page).fill("# Preserved shared draft");
    await expect
      .poll(async () => {
        const documents = await (
          await fetch(before.edit + "/api/v1/documents")
        ).json();
        return documents.find((document: any) => document.path === "a.md")
          .snapshot.text;
      })
      .toBe("# Preserved shared draft");
    await stop();
    await expect(
      page.getByRole("region", { name: "远端连接状态" }),
    ).toBeVisible();
    await writeFile(
      config,
      configuration("random configuration secret value new 1234567890"),
    );
    const after = await start();
    expect(after.readonly).not.toBe(before.readonly);
    expect(after.edit).not.toBe(before.edit);
    for (const old of [before.readonly, before.edit])
      expect((await fetch(old + "/api/v1")).status).toBe(404);
    const rotatedIdentity = (await (await fetch(after.edit + "/api/v1")).json())
      .vaultIdentity;
    expect(rotatedIdentity.id).not.toBe(identity.id);
    expect(rotatedIdentity.historyId).not.toBe(identity.historyId);
    await page
      .getByRole("button", { name: "尝试重新连接", exact: true })
      .click();
    await expect(
      page.getByRole("region", { name: "远端连接状态" }),
    ).toContainText("Link not found");
    await expect(editor(page)).toHaveText("# Preserved shared draft");
    await connect(page, after.edit);
    await page.getByRole("treeitem", { name: "a.md", exact: true }).click();
    await expect(editor(page)).toHaveText("# Original");
    await expect(editor(page)).toHaveAttribute("contenteditable", "true");
    expect(await readFile(join(root, "notes", "a.md"), "utf8")).toBe(
      "# Original",
    );
  } finally {
    await stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("remote save failure retains the preview and draft, pauses editing and can be reauthenticated", async ({
  page,
  api,
}) => {
  const name = "offline-preview.md";
  await writeFile(join(api.root, "notes", name), "# Original\n\nbody");
  await installWorkerHarness(page, true);
  await page.goto("/");
  await connect(page, api.url);
  await page.getByRole("treeitem", { name, exact: true }).click();
  await page.getByRole("button", { name: "分栏", exact: true }).click();
  const preview = page.getByRole("region", { name: "文档预览" });
  await expect(preview.locator("h1")).toHaveText("Original");

  await editor(page).fill("# Preserved draft\n\n😀 中文");
  await expect(preview.locator("h1")).toHaveText("Preserved draft");
  await expect
    .poll(
      async () =>
        (await hostDocuments(api)).find((d) => d.path === name)?.snapshot.text,
    )
    .toBe("# Preserved draft\n\n😀 中文");
  await workerEvaluate(
    page,
    () =>
      (self as unknown as { testSockets: WebSocket[] }).testSockets.forEach(
        (socket) => socket.close(),
      ),
    undefined,
    -1,
  );
  await page.keyboard.press("Control+s");
  await expect(
    page.getByRole("region", { name: "远端连接状态" }),
  ).toContainText("远端连接已断开");
  await expect(editor(page)).toHaveAttribute("contenteditable", "false");
  await expect(editor(page)).toContainText("Preserved draft");
  await expect(
    page.locator('[aria-label="文档预览"]').locator("h1"),
  ).toHaveText("Preserved draft");
  expect(await readFile(join(api.root, "notes", name), "utf8")).toContain(
    "Original",
  );
  await expect(page.locator(".workspace-content-body[inert]")).toHaveCount(1);
  await expect(page.locator(".editor-tab-label")).toContainText(name);
  await expect(editor(page)).toContainText("Preserved draft");

  await workerEvaluate(
    page,
    () => {
      (self as unknown as { failConnections: boolean }).failConnections = true;
    },
    undefined,
    -1,
  );
  await page.getByRole("button", { name: "尝试重新连接", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "远端连接状态" }),
  ).toContainText("无法连接远端协作会话");
  expect(
    await editor(page).evaluate((element) =>
      (element as any).cmTile.root.view.state.doc.toString(),
    ),
  ).toBe("# Preserved draft\n\n😀 中文");
  await expect(editor(page)).toHaveAttribute("contenteditable", "false");
  await workerEvaluate(
    page,
    () => {
      (self as unknown as { failConnections: boolean }).failConnections = false;
    },
    undefined,
    -1,
  );
  await page.getByRole("button", { name: "尝试重新连接", exact: true }).click();
  await expect(editor(page)).toHaveAttribute("contenteditable", "true");
  await editor(page).focus();
  await page.keyboard.press("Control+s");
  await expect(page.getByRole("status", { name: "保存状态" })).toHaveText(
    "已保存",
  );
  expect(await readFile(join(api.root, "notes", name), "utf8")).toBe(
    "# Preserved draft\n\n😀 中文",
  );
});

test("reauthentication rejects a changed host history and retains the client draft", async ({
  page,
  api,
}) => {
  const name = "history-check.md";
  await writeFile(join(api.root, "notes", name), "# Original");
  await page.goto("/");
  await connect(page, api.url);
  await page.getByRole("treeitem", { name, exact: true }).click();
  await expect(editor(page)).toHaveText("# Original");
  await editor(page).focus();
  await page.keyboard.press("Control+a");
  await page.keyboard.insertText("# Keep this draft");
  await expect
    .poll(
      async () =>
        (await hostDocuments(api)).find((d) => d.path === name)?.snapshot.text,
    )
    .toBe("# Keep this draft");
  await page.context().route(api.url + "/api/v1", async (route) => {
    const response = await route.fetch();
    const descriptor = await response.json();
    descriptor.vaultIdentity.historyId = "another-host-history";
    await route.fulfill({ response, json: descriptor });
  });
  await page.getByRole("button", { name: "管理 Vault", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "管理 Vault", exact: true });
  await dialog.getByLabel("连接远端 Vault", { exact: true }).fill(api.url);
  await dialog.getByRole("button", { name: "连接", exact: true }).click();
  await expect(dialog).toContainText("远端 Vault 历史已改变");
  await dialog.getByRole("button", { name: "关闭弹窗", exact: true }).click();
  await expect(editor(page)).toHaveAttribute("contenteditable", "false");
  await expect(editor(page)).toHaveText("# Keep this draft");
  expect(await readFile(join(api.root, "notes", name), "utf8")).toBe(
    "# Original",
  );
  await page.context().unroute(api.url + "/api/v1");

  await connect(page, api.url);
  await expect(editor(page)).toHaveAttribute("contenteditable", "true");
  await editor(page).focus();
  await page.keyboard.press("Control+s");
  await expect(page.getByRole("status", { name: "保存状态" })).toHaveText(
    "已保存",
  );
  expect(await readFile(join(api.root, "notes", name), "utf8")).toBe(
    "# Keep this draft",
  );
});

test("unconfirmed input blocks removing the connection and remains copyable", async ({
  page,
  api,
}) => {
  await installWorkerHarness(page, true);
  await page.goto("/");
  await connect(page, api.url);
  await page.getByRole("treeitem", { name: "a.md", exact: true }).click();
  await workerEvaluate(
    page,
    () => {
      (self as any).dropNextUpdate = true;
    },
    undefined,
    -1,
  );
  await editor(page).fill("keep unsaved shared draft");
  await expect(editor(page)).toHaveAttribute("contenteditable", "false");
  await page.getByRole("button", { name: "管理 Vault", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "管理 Vault" });
  await dialog.getByRole("button", { name: "移除连接 notes" }).click();
  await dialog
    .getByRole("button", { name: "确认移除连接", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toContainText("连接仍保留");
  await dialog.getByRole("button", { name: "关闭弹窗", exact: true }).click();
  await expect(editor(page)).toHaveText("keep unsaved shared draft");
});

test("reconnect accepts reused paths and opening a recreated path uses its new history", async ({
  page,
  api,
}) => {
  const a = "reconnect-path-a.md",
    b = "reconnect-path-b.md",
    c = "reconnect-path-c.md";
  await writeFile(join(api.root, "notes", a), "A");
  await writeFile(join(api.root, "notes", b), "B");
  await installWorkerHarness(page, true);
  await page.goto("/");
  await connect(page, api.url);
  await page.getByRole("treeitem", { name: a, exact: true }).click();
  await expect(editor(page)).toHaveText("A");
  await workerEvaluate(
    page,
    () =>
      (self as any).testSockets.forEach((socket: WebSocket) => socket.close()),
    undefined,
    -1,
  );
  const overlay = page.getByRole("region", { name: "远端连接状态" });
  await expect(overlay).toBeVisible();
  await page.evaluate(
    async ({ api, a, b, c }) => {
      const moduleUrl = "/src/lib/vault/index.ts";
      const { openHttpVault, vaultPath } = await import(moduleUrl);
      const { backend } = await openHttpVault(api.url);
      await backend.rename(vaultPath(a), vaultPath(c));
      await backend.rename(vaultPath(b), vaultPath(a));
      await backend.close();
    },
    { api, a, b, c },
  );
  await overlay
    .getByRole("button", { name: "尝试重新连接", exact: true })
    .click();
  await expect(overlay).toHaveCount(0);
  await expect(page.getByRole("tab", { name: c, exact: true })).toBeVisible();
  await expect(editor(page)).toHaveText("A");
  await page.getByRole("treeitem", { name: a, exact: true }).click();
  await expect(editor(page)).toHaveText("B");
  await page.evaluate(
    async ({ api, a }) => {
      const moduleUrl = "/src/lib/vault/index.ts";
      const { openHttpVault, vaultPath } = await import(moduleUrl);
      const { backend } = await openHttpVault(api.url);
      await backend.remove(vaultPath(a));
      await backend.writeFile(vaultPath(a), new TextEncoder().encode("new A"), {
        mode: "create",
      });
      await backend.close();
    },
    { api, a },
  );
  await expect(editor(page)).toHaveAttribute("contenteditable", "false");
  await expect(editor(page)).toHaveText("B");
  await expect(
    page.getByRole("treeitem", { name: a, exact: true }),
  ).toBeVisible();
  await page.getByRole("treeitem", { name: a, exact: true }).click();
  await expect(editor(page)).toHaveText("new A");
  await expect(editor(page)).toHaveAttribute("contenteditable", "true");
  await page.reload();
  await connect(page, api.url);
  await page.getByRole("treeitem", { name: a, exact: true }).click();
  await expect(editor(page)).toHaveText("new A");
});

test("rejected input stays exportable and can be withdrawn without reconnecting", async ({
  page,
  api,
}) => {
  const name = "rejected-input.md";
  const disk = join(api.root, "notes", name);
  await writeFile(disk, "base");
  await page.goto("/");
  await connect(page, api.url);
  await page.getByRole("treeitem", { name, exact: true }).click();
  await expect(editor(page)).toHaveText("base");
  await editor(page).evaluate((element) => {
    const view = (element as any).cmTile.root.view;
    view.dispatch({ changes: { from: 4, insert: "\u0000" } });
    view.dispatch({ changes: { from: 5, insert: "dependent" } });
  });
  const overlay = page.getByRole("region", { name: "远端连接状态" });
  await expect(overlay).toContainText("输入未被接受");
  await expect(editor(page)).toHaveAttribute("contenteditable", "false");
  const exported = page.waitForEvent("download");
  await overlay.getByRole("button", { name: "导出当前正文" }).click();
  const download = await exported;
  const drafts = JSON.parse(await readFile((await download.path())!, "utf8"));
  expect(
    drafts.find((draft: { path: string }) => draft.path === name).content,
  ).toBe("base\u0000dependent");
  expect(
    (await hostDocuments(api)).find((d) => d.path === name)?.snapshot.text,
  ).toBe("base");
  await overlay.getByRole("button", { name: "撤回未接受输入" }).click();
  await expect(overlay).toHaveCount(0);
  await expect(editor(page)).toHaveText("base");
  await expect(editor(page)).toHaveAttribute("contenteditable", "true");
  await editor(page).fill("accepted");
  await expect
    .poll(
      async () =>
        (await hostDocuments(api)).find((d) => d.path === name)?.snapshot.text,
    )
    .toBe("accepted");
  expect(await readFile(disk, "utf8")).toBe("base");
});

test("shared save conflicts offer retry without discarding shared history", async ({
  page,
  api,
}) => {
  const name = "shared-save-conflict.md";
  const disk = join(api.root, "notes", name);
  await writeFile(disk, "base");
  await installWorkerHarness(page, true);
  await page.goto("/");
  await connect(page, api.url);
  await page.getByRole("treeitem", { name, exact: true }).click();
  await editor(page).fill("shared draft");
  await expect
    .poll(
      async () =>
        (await hostDocuments(api)).find((d) => d.path === name)?.snapshot.text,
    )
    .toBe("shared draft");
  await workerEvaluate(
    page,
    () => {
      (self as any).rejectNextSave = true;
    },
    undefined,
    -1,
  );
  await page.keyboard.press("Control+s");
  const dialog = page.getByRole("dialog", { name: "共享文档暂时无法保存" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "丢弃编辑" })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "覆盖保存" })).toHaveCount(0);
  expect(await readFile(disk, "utf8")).toBe("base");
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await expect(editor(page)).toHaveText("shared draft");
  await workerEvaluate(
    page,
    () => {
      (self as any).rejectNextSave = true;
    },
    undefined,
    -1,
  );
  await editor(page).focus();
  await page.keyboard.press("Control+s");
  await dialog.getByRole("button", { name: "重试保存" }).click();
  await expect(dialog).not.toBeVisible();
  await expect.poll(() => readFile(disk, "utf8")).toBe("shared draft");
});

test("removing a confirmed shared connection preserves unsaved host files including unopened documents", async ({
  page,
  browser,
  api,
}) => {
  const names = ["close-open.md", "close-unopened.md"];
  for (const name of names)
    await writeFile(join(api.root, "notes", name), "disk");
  await page.goto("/");
  await connect(page, api.url);
  await page.getByRole("treeitem", { name: names[0], exact: true }).click();
  await editor(page).fill("open shared draft");
  const otherContext = await browser.newContext();
  try {
    const other = await otherContext.newPage();
    await other.goto("/");
    await connect(other, api.url);
    await other.getByRole("treeitem", { name: names[1], exact: true }).click();
    await editor(other).fill("unopened shared draft");
    await expect
      .poll(async () =>
        (await hostDocuments(api))
          .filter((d) => names.includes(d.path))
          .map((d) => d.snapshot.text)
          .sort(),
      )
      .toEqual(["open shared draft", "unopened shared draft"]);
    await page.getByRole("button", { name: "管理 Vault", exact: true }).click();
    const dialog = page.getByRole("dialog", {
      name: "管理 Vault",
      exact: true,
    });
    await dialog.getByRole("button", { name: "移除连接 notes" }).click();
    await dialog
      .getByRole("button", { name: "确认移除连接", exact: true })
      .click();
    await expect(
      dialog.getByRole("button", { name: "移除连接 notes" }),
    ).toHaveCount(0);
    for (const name of names)
      expect(await readFile(join(api.root, "notes", name), "utf8")).toBe(
        "disk",
      );
    await dialog.getByRole("button", { name: "关闭弹窗", exact: true }).click();
    await connect(page, api.url);
    await page.getByRole("treeitem", { name: names[0], exact: true }).click();
    await expect(editor(page)).toHaveText("open shared draft");
  } finally {
    await otherContext.close();
  }
});

test("mobile connection controls fit the viewport", async ({ page, api }) => {
  await page.setViewportSize({ width: 360, height: 640 });
  await page.goto("/");
  await connect(page, api.url);
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
  await connect(page, api.url);
  await page.getByRole("button", { name: "新建文件夹", exact: true }).click();
  await page.getByRole("textbox", { name: "名称", exact: true }).fill("drafts");
  await page.getByRole("button", { name: "确认", exact: true }).click();
  await expect(
    page.getByRole("treeitem", { name: "drafts", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "新建文件", exact: true }).click();
  await page.getByRole("textbox", { name: "名称", exact: true }).fill("new.md");
  await page.getByRole("button", { name: "确认", exact: true }).click();
  await expect(
    page.getByRole("tree", { name: "文件树", exact: true }),
  ).toHaveAttribute("aria-busy", "false");
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
  await expect(
    page.getByRole("tree", { name: "文件树", exact: true }),
  ).toBeFocused();
  await expect(
    page.getByRole("tree", { name: "文件树", exact: true }),
  ).toHaveAttribute("aria-busy", "false");
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

async function openSyncDebug(page: Page, api: Api, path: string) {
  await page.goto("/debug/sync");
  await page.getByLabel("Vault URL", { exact: true }).fill(api.url);
  await page.getByRole("button", { name: "连接 server", exact: true }).click();
  await page.getByLabel("调试文档", { exact: true }).selectOption(path);
  expect((await hostDocuments(api)).some((doc) => doc.path === path)).toBe(
    false,
  );
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
  const pattern = `${api.url}/api/v1/documents/**`;
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

test("sync debug honors share credentials and read-only vaults", async ({
  page,
  api,
}) => {
  const path = `debug-readonly-${crypto.randomUUID()}.md`;
  await writeFile(join(api.root, "readonly", path), "A😀B");
  await page.goto("/debug/sync");
  await page
    .getByLabel("Vault URL", { exact: true })
    .fill(api.urls.readonly.replace("/ro-", "/"));
  await page.getByRole("button", { name: "连接 server", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("NotFound");
  await page.getByLabel("Vault URL", { exact: true }).fill(api.urls.readonly);
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

async function viewCommand(
  page: Page,
  action: "start" | "end" | "middle" | "burst",
) {
  await expect(editor(page)).toBeVisible();
  await page.evaluate((action) => {
    const view = (document.querySelector(".cm-content") as any).cmTile.root
      .view;
    if (action === "burst")
      for (let i = 0; i < 25; i++)
        view.dispatch({
          changes: { from: view.state.doc.length, insert: "x" },
        });
    else
      view.dispatch({
        selection: {
          anchor:
            action === "start"
              ? 0
              : action === "end"
                ? view.state.doc.length
                : 8,
        },
      });
  }, action);
}
async function cursorOffset(page: Page) {
  return page.evaluate(
    () =>
      (document.querySelector(".cm-content") as any).cmTile.root.view.state
        .selection.main.head,
  );
}
test("two online editors converge live and undo only their own writer", async ({
  page,
  browser,
  api,
}) => {
  const name = "collaboration.md";
  await writeFile(join(api.root, "notes", name), "left 🦀 middle right");
  const context = await browser.newContext({
    baseURL: "http://127.0.0.1:1430",
  });
  const other = await context.newPage();
  try {
    for (const client of [page, other]) {
      await client.goto("/");
      await connect(client, api.url);
      await client.getByRole("treeitem", { name, exact: true }).click();
      await expect(editor(client)).toHaveText("left 🦀 middle right");
      await editor(client).focus();
    }
    await viewCommand(page, "start");
    await viewCommand(other, "end");
    await Promise.all([
      page.keyboard.insertText("A:"),
      other.keyboard.insertText(":B"),
    ]);
    for (const client of [page, other])
      await expect(editor(client)).toHaveText("A:left 🦀 middle right:B");
    expect(await readFile(join(api.root, "notes", name), "utf8")).toBe(
      "left 🦀 middle right",
    );
    await page.keyboard.press("Control+z");
    for (const client of [page, other])
      await expect(editor(client)).toHaveText("left 🦀 middle right:B");
    await other.keyboard.press("Control+z");
    for (const client of [page, other])
      await expect(editor(client)).toHaveText("left 🦀 middle right");
    await page.keyboard.press("Control+y");
    for (const client of [page, other])
      await expect(editor(client)).toHaveText("A:left 🦀 middle right");
    await other.keyboard.press("Control+s");
    await expect
      .poll(() => readFile(join(api.root, "notes", name), "utf8"))
      .toBe("A:left 🦀 middle right");
  } finally {
    await context.close();
  }
});
test("remote changes preserve a cursor inside unchanged text and wait for IME completion", async ({
  page,
  api,
}) => {
  const name = "cursor-ime.md";
  const disk = join(api.root, "notes", name);
  await writeFile(disk, "abc 🦀 middle xyz");
  await page.goto("/");
  await connect(page, api.url);
  await page.getByRole("treeitem", { name, exact: true }).click();
  await viewCommand(page, "middle");
  await writeFile(disk, "PREFIX abc 🦀 middle xyz SUFFIX");
  await expect(editor(page)).toHaveText("PREFIX abc 🦀 middle xyz SUFFIX");
  expect(await cursorOffset(page)).toBe(15);
  await editor(page).dispatchEvent("compositionstart");
  await writeFile(disk, "REMOTE PREFIX abc 🦀 middle xyz SUFFIX");
  await expect
    .poll(
      async () =>
        (await hostDocuments(api)).find((d) => d.path === name)?.snapshot.text,
    )
    .toBe("REMOTE PREFIX abc 🦀 middle xyz SUFFIX");
  await expect(editor(page)).toHaveText("PREFIX abc 🦀 middle xyz SUFFIX");
  await editor(page).dispatchEvent("compositionend");
  await expect(editor(page)).toHaveText(
    "REMOTE PREFIX abc 🦀 middle xyz SUFFIX",
  );
  expect(await cursorOffset(page)).toBe(22);
});
test("remote updates rebase a burst of pending input without losing characters", async ({
  page,
  api,
}) => {
  const name = "pending-input.md";
  const disk = join(api.root, "notes", name);
  await writeFile(disk, "base");
  await installWorkerHarness(page, true);
  await page.goto("/");
  await connect(page, api.url);
  await page.getByRole("treeitem", { name, exact: true }).click();
  await workerEvaluate(
    page,
    () => {
      (self as unknown as { delayReplies: boolean }).delayReplies = true;
    },
    undefined,
    -1,
  );
  await viewCommand(page, "burst");
  await writeFile(disk, "REMOTE:base");
  const merged = "REMOTE:base" + "x".repeat(25);
  await expect(editor(page)).toHaveText(merged);
  await expect
    .poll(
      async () =>
        (await hostDocuments(api)).find((d) => d.path === name)?.snapshot.text,
    )
    .toBe(merged);
  await editor(page).focus();
  await page.keyboard.press("Control+s");
  await expect.poll(() => readFile(disk, "utf8")).toBe(merged);
});

for (const failure of ["before-send", "lost-ack"] as const) {
  test(`disconnect ${failure} freezes all views and reconnects from host without replaying queued input`, async ({
    page,
    api,
  }) => {
    const name = `reconnect-${failure}.md`;
    const disk = join(api.root, "notes", name);
    await writeFile(disk, "base");
    await installWorkerHarness(page, true);
    await page.goto("/");
    await connect(page, api.url);
    await page.getByRole("treeitem", { name, exact: true }).click();
    await expect(editor(page)).toHaveText("base");

    await workerEvaluate(
      page,
      (failure) => {
        const control = self as unknown as {
          dropNextUpdate: boolean;
          dropNextReply: boolean;
        };
        control.dropNextUpdate = failure === "before-send";
        control.dropNextReply = failure === "lost-ack";
      },
      failure,
      -1,
    );
    await viewCommand(page, "burst");
    const overlay = page.getByRole("region", { name: "远端连接状态" });
    await expect(overlay).toContainText("尚有未确认输入");
    await expect(editor(page)).toHaveAttribute("contenteditable", "false");
    await expect(page.locator(".workspace-content-body[inert]")).toHaveCount(1);
    await expect(editor(page)).toHaveText("base" + "x".repeat(25));
    const exported = page.waitForEvent("download");
    await overlay.getByRole("button", { name: "导出当前正文" }).click();
    const download = await exported;
    const drafts = JSON.parse(await readFile((await download.path())!, "utf8"));
    expect(
      drafts.find((draft: { path: string }) => draft.path === name).content,
    ).toBe("base" + "x".repeat(25));
    await overlay
      .getByRole("button", { name: "丢弃未确认输入并重新连接" })
      .click();
    await expect(overlay).toHaveCount(0);
    const expected = failure === "lost-ack" ? "basex" : "base";
    await expect(editor(page)).toHaveText(expected);
    await expect(editor(page)).toHaveAttribute("contenteditable", "true");
    // A delayed old reply and the remaining queued inputs cannot mutate the new session.
    await page.waitForTimeout(700);
    await expect(editor(page)).toHaveText(expected);
    await expect
      .poll(
        async () =>
          (await hostDocuments(api)).find((doc) => doc.path === name)?.snapshot
            .text,
      )
      .toBe(expected);
    await editor(page).focus();
    await page.keyboard.press("Control+z");
    await page.waitForFunction(
      (name) =>
        (window as unknown as { editorMessages: any[] }).editorMessages.some(
          (message) =>
            message.kind === "reply" &&
            message.result?.document?.path === name &&
            message.result.edits?.length === 0,
        ),
      name,
    );
    await expect(editor(page)).toHaveText(expected);
    await page.keyboard.press("Control+End");
    await page.keyboard.insertText("NEW");
    await expect
      .poll(
        async () =>
          (await hostDocuments(api)).find((doc) => doc.path === name)?.snapshot
            .text,
      )
      .toBe(expected + "NEW");
    await page.keyboard.press("Control+s");
    await expect.poll(() => readFile(disk, "utf8")).toBe(expected + "NEW");
  });
}

for (const surface of ["menu", "dialog", "mobile-editor"] as const) {
  test(`disconnect blocks the whole Vault workspace and dismisses ${surface}`, async ({
    page,
    api,
  }) => {
    if (surface === "mobile-editor")
      await page.setViewportSize({ width: 360, height: 640 });
    const name = `whole-workspace-${surface}.md`;
    const disk = join(api.root, "notes", name);
    await writeFile(disk, "original");
    await installWorkerHarness(page, true);
    await page.goto("/");
    await connect(page, api.url);
    const file = page.getByRole("treeitem", { name, exact: true });
    if (surface === "mobile-editor") {
      await file.click();
      await expect(editor(page)).toHaveText("original");
    } else {
      await file.click({ button: "right" });
      await expect(page.getByRole("menu")).toBeVisible();
      if (surface === "dialog") {
        await page.getByRole("menuitem", { name: /重命名/ }).click();
        const dialog = page.getByRole("dialog", {
          name: "重命名",
          exact: true,
        });
        await dialog
          .getByLabel("名称", { exact: true })
          .fill("should-not-rename.md");
      }
    }
    await workerEvaluate(
      page,
      () =>
        (self as unknown as { testSockets: WebSocket[] }).testSockets.forEach(
          (socket) => socket.close(),
        ),
      undefined,
      -1,
    );
    const overlay = page.getByRole("region", { name: "远端连接状态" });
    await expect(overlay).toBeVisible();
    await expect(page.locator(".workspace-content-body[inert]")).toHaveCount(1);
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(
      page.getByRole("dialog", { name: "重命名", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("tree", { name: "文件树", exact: true }),
    ).toHaveCount(0);
    expect(
      await page
        .locator(".workspace-content-body")
        .evaluate((element) => (element as HTMLElement).inert),
    ).toBe(true);
    const cover = (await overlay.boundingBox())!;
    const content = (await page.locator(".workspace-content").boundingBox())!;
    expect(cover).toEqual(content);
    const sidebar = (await page.locator(".workspace-sidebar").boundingBox())!;
    const point = { x: sidebar.x + 24, y: sidebar.y + 24 };
    expect(
      await page.evaluate(
        ({ x, y }) =>
          !!document
            .elementFromPoint(x, y)
            ?.closest(".vault-connection-overlay"),
        point,
      ),
    ).toBe(true);
    await page.mouse.click(point.x, point.y);
    await page.keyboard.press("F2");
    await page.keyboard.press("Delete");
    await page.keyboard.insertText("should-not-edit");
    await page.keyboard.press("Control+s");
    await expect(
      page.getByRole("dialog", { name: "重命名", exact: true }),
    ).toHaveCount(0);
    expect(await readFile(disk, "utf8")).toBe("original");
    if (surface === "mobile-editor") {
      await expect(editor(page)).toHaveAttribute("contenteditable", "false");
      await expect(editor(page)).toHaveText("original");
    }
    await expect(
      page.getByRole("button", { name: "管理 Vault", exact: true }),
    ).toBeVisible();
    await overlay
      .getByRole("button", { name: "尝试重新连接", exact: true })
      .click();
    await expect(overlay).toHaveCount(0);
    await expect(page.locator(".workspace-content-body[inert]")).toHaveCount(0);
    await expect(page.getByRole("menu")).toHaveCount(0);
    if (surface === "mobile-editor") {
      await expect(editor(page)).toHaveAttribute("contenteditable", "true");
      await page
        .getByRole("button", { name: "返回文件树", exact: true })
        .click();
    }
    await expect(
      page.getByRole("tree", { name: "文件树", exact: true }),
    ).toBeVisible();
    await expect(file).toBeVisible();
  });
}

for (const signal of ["SIGTERM", "SIGKILL"] as const) {
  test(`server ${signal} restart discards unsaved history and rejects old Web sessions`, async ({
    page,
    browser,
    baseURL,
  }) => {
    const root = await mkdtemp(join(tmpdir(), "celestite-memory-browser-"));
    const listener = createServer();
    await new Promise<void>((resolve) =>
      listener.listen(0, "127.0.0.1", resolve),
    );
    const port = (listener.address() as { port: number }).port;
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    const api: Api = {
      root,
      url: "",
      urls: {},
    };
    const config = join(root, "config.toml");
    const env = { ...process.env };
    const disk = join(root, "notes", "a.md");
    let child: ChildProcess | undefined;
    const context = await browser.newContext({ baseURL });
    const other = await context.newPage();
    const start = async () => {
      child = spawn(binary, ["--config", config], {
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let errors = "";
      child.stderr?.on("data", (data) => (errors += String(data)));
      await expect
        .poll(
          async () => {
            if (child!.exitCode !== null || child!.signalCode !== null)
              throw new Error(`server exited: ${errors}`);
            try {
              return (
                (
                  await fetch(`http://127.0.0.1:${port}/`, {
                    signal: AbortSignal.timeout(1000),
                  })
                ).status === 404
              );
            } catch {
              return false;
            }
          },
          { timeout: 10000 },
        )
        .toBe(true);
      const links = startupLinks(errors);
      if (api.url) expect(links.edit).toBe(api.url);
      api.url = links.edit;
      api.urls.notes = api.url;
    };
    const stop = async (signal: "SIGTERM" | "SIGKILL") => {
      const process = child;
      if (!process || process.exitCode !== null || process.signalCode !== null)
        return;
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => process.kill("SIGKILL"), 5000);
        process.once("exit", () => {
          clearTimeout(timeout);
          resolve();
        });
        process.kill(signal);
      });
      child = undefined;
    };
    try {
      await mkdir(join(root, "notes"));
      await writeFile(disk, "left 🦀 middle right");
      await writeFile(join(root, "notes", "unopened.md"), "unopened original");
      await writeFile(
        config,
        `[server]\nlisten = "127.0.0.1:${port}"\nallowed_origins = [${JSON.stringify(baseURL)}]\n\n[vault]\nname = "notes"\npath = "notes"\nshare_key = "browser restart test secret 0123456789"\n`,
      );
      await start();
      expect(await hostDocuments(api)).toEqual([]);
      const identity = (await (await fetch(api.url + "/api/v1", {})).json())
        .vaultIdentity;
      for (const client of [page, other]) {
        await installWorkerHarness(client, true);
        await client.goto("/");
        await connect(client, api.url);
        await client
          .getByRole("treeitem", { name: "a.md", exact: true })
          .click();
        await expect(editor(client)).toHaveText("left 🦀 middle right");
      }
      await viewCommand(page, "start");
      await editor(page).focus();
      await page.keyboard.insertText("A:");
      for (const client of [page, other])
        await expect(editor(client)).toHaveText("A:left 🦀 middle right");
      await viewCommand(other, "end");
      await editor(other).focus();
      await other.keyboard.insertText(":B");
      for (const client of [page, other])
        await expect(editor(client)).toHaveText("A:left 🦀 middle right:B");
      await expect
        .poll(
          async () =>
            (await hostDocuments(api)).find((doc) => doc.path === "a.md")
              ?.snapshot.text,
        )
        .toBe("A:left 🦀 middle right:B");
      const documentId = (await hostDocuments(api)).find(
        (doc) => doc.path === "a.md",
      )!.id;
      expect(await readFile(disk, "utf8")).toBe("left 🦀 middle right");
      await stop(signal);
      for (const client of [page, other]) {
        const overlay = client.getByRole("region", { name: "远端连接状态" });
        await expect(overlay).toBeVisible();
        await expect(editor(client)).toHaveAttribute(
          "contenteditable",
          "false",
        );
        await expect(client.locator(".workspace-content-body")).toHaveAttribute(
          "inert",
          "",
        );
        await overlay
          .getByRole("button", { name: "尝试重新连接", exact: true })
          .click();
        await expect(overlay.getByRole("heading")).toHaveText("远端连接已断开");
        await expect(editor(client)).toHaveText("A:left 🦀 middle right:B");
      }
      await writeFile(disk, "left 🦀 disk right");
      await writeFile(
        join(root, "notes", "unopened.md"),
        "changed while host stopped",
      );
      await start();
      const recoveredIdentity = (
        await (await fetch(api.url + "/api/v1", {})).json()
      ).vaultIdentity;
      expect(recoveredIdentity.id).toBe(identity.id);
      expect(recoveredIdentity.historyId).not.toBe(identity.historyId);
      expect(await hostDocuments(api)).toEqual([]);
      for (const client of [page, other]) {
        await client
          .getByRole("button", { name: "尝试重新连接", exact: true })
          .click();
        await expect(
          client.getByRole("region", { name: "远端连接状态" }),
        ).toContainText("远端 Vault 历史已改变");
        await expect(editor(client)).toHaveAttribute(
          "contenteditable",
          "false",
        );
        await expect(editor(client)).toHaveText("A:left 🦀 middle right:B");
      }
      expect(await hostDocuments(api)).toEqual([]);
      const expected = "left 🦀 disk right";
      for (const client of [page, other]) {
        await client.reload();
        await connect(client, api.url);
        await client
          .getByRole("treeitem", { name: "a.md", exact: true })
          .click();
        await expect(editor(client)).toHaveAttribute("contenteditable", "true");
        await expect(editor(client)).toHaveText(expected);
      }
      const recoveredDocument = (await hostDocuments(api)).find(
        (doc) => doc.path === "a.md",
      )!;
      expect(recoveredDocument.id).not.toBe(documentId);
      expect(recoveredDocument.snapshot.text).toBe(expected);
      expect(await readFile(disk, "utf8")).toBe("left 🦀 disk right");
      await editor(page).focus();
      await page.keyboard.press("Control+z");
      await page.waitForFunction(() =>
        (window as unknown as { editorMessages: any[] }).editorMessages.some(
          (message) =>
            message.kind === "reply" &&
            message.result?.document?.path === "a.md" &&
            message.result.edits?.length === 0,
        ),
      );
      await expect(editor(page)).toHaveText(expected);
      await other
        .getByRole("treeitem", { name: "unopened.md", exact: true })
        .click();
      await expect(editor(other)).toHaveText("changed while host stopped");
      await other.getByRole("tab", { name: "a.md", exact: true }).click();
      await viewCommand(page, "end");
      await page.keyboard.insertText(":NEW");
      for (const client of [page, other])
        await expect(editor(client)).toHaveText(expected + ":NEW");
      await editor(other).focus();
      await other.keyboard.press("Control+s");
      await expect.poll(() => readFile(disk, "utf8")).toBe(expected + ":NEW");
      await expect(other.getByRole("status", { name: "保存状态" })).toHaveText(
        "已保存",
      );
    } finally {
      await context.close();
      await stop("SIGTERM");
      await rm(root, { recursive: true, force: true });
    }
  });
}
