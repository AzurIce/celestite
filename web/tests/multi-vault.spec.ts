import {
  chooseEditorMode,
  expectEditorMode,
  openDocumentOptions,
  fileAction,
} from "./editor-actions";
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
import {
  expectActiveVault,
  openVaultManager,
  openVaultMenu,
  selectVault,
  vaultSwitcher,
} from "./vault-actions";

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
async function openNavigation(page: Page) {
  const switcher = vaultSwitcher(page);
  const toggle = page.getByRole("button", {
    name: "切换文件导航",
    exact: true,
  });
  await expect(switcher.or(toggle).first()).toBeVisible();
  // Recovery and startup failures expose connection controls directly.
  if (!(await switcher.isVisible())) {
    await toggle.click();
    await expect(
      page.getByRole("tree", { name: "文件树", exact: true }),
    ).toBeVisible();
  }
}
async function connect(page: Page, url: string) {
  await openNavigation(page);
  const dialog = await openVaultManager(page);
  await dialog.getByLabel("连接远端 Vault", { exact: true }).fill(url);
  await dialog.getByRole("button", { name: "连接", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await openNavigation(page);
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

test("remote language analysis uses unsaved imports and refreshes external module diagnostics", async ({
  page,
  api,
}) => {
  const moduleRoot = join(api.root, "packages", "language");
  await mkdir(moduleRoot, { recursive: true });
  const declaration = "fn greet() -> BlockContent;";
  await writeFile(join(moduleRoot, "lib.notc"), declaration);
  await writeFile(
    join(api.root, "notes", "language.not"),
    "= Remote language\n",
  );
  await installWorkerHarness(page);
  const reads: {
    context: { documentPath: string; source: string };
    request: { path: string };
  }[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/preview/resources"))
      reads.push(request.postDataJSON());
  });
  await page.goto("/");
  await connect(page, api.url);
  await page
    .getByRole("treeitem", { name: "language.not", exact: true })
    .click();
  const source =
    '= Remote language\n\n#import "../packages/language/lib.notc" as library;\n\n#library.greet()\n';
  await editor(page).fill(source);
  const call = await editor(page).evaluate((element) => {
    const view = (element as any).cmTile.root.view;
    const offset = view.state.doc.toString().indexOf("greet()") + 1;
    return view.coordsAtPos(offset);
  });
  expect(call).not.toBeNull();
  await page.mouse.move(
    (call!.left + call!.right) / 2,
    (call!.top + call!.bottom) / 2,
  );
  await expect(page.locator(".cm-tooltip").first()).toContainText("greet");
  await expect
    .poll(() =>
      reads.some(
        (read) =>
          read.context.documentPath === "language.not" &&
          read.context.source === source &&
          read.request.path === join(moduleRoot, "lib.notc"),
      ),
    )
    .toBe(true);
  expect(await readFile(join(api.root, "notes", "language.not"), "utf8")).toBe(
    "= Remote language\n",
  );
  const diagnostics = () =>
    page.evaluate(() => {
      const messages = (
        window as unknown as {
          editorMessages: { kind: string; message?: string }[];
        }
      ).editorMessages;
      return (
        messages
          .filter((message) => message.kind === "language")
          .map((message) => JSON.parse(message.message!))
          .filter(
            (message) =>
              message.method === "textDocument/publishDiagnostics" &&
              message.params.uri === "file:///vault/language.not",
          )
          .at(-1)
          ?.params.diagnostics.map(
            (diagnostic: { message: string }) => diagnostic.message,
          ) ?? null
      );
    });
  await expect.poll(diagnostics).toEqual([]);
  await writeFile(
    join(moduleRoot, "lib.notc"),
    "fn renamed() -> BlockContent;",
  );
  await expect
    .poll(diagnostics)
    .toEqual(
      expect.arrayContaining([expect.stringContaining("library.greet")]),
    );
  await writeFile(join(moduleRoot, "lib.notc"), declaration);
  await expect.poll(diagnostics).toEqual([]);
});

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
  await openDocumentOptions(page);
  await expect(
    page.getByRole("menuitem", { name: "保存", exact: true }),
  ).toBeDisabled();
  await page.keyboard.press("Escape");
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
  const response = await fetch(api.urls[vault] + "/api/v5/documents");
  return response.json();
}
test("collaborative input is accepted in memory while disk save stays explicit", async ({
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
  await selectVault(page, "我的 Vault");
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
  await selectVault(page, "notes");
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
  await installWorkerHarness(page, true);
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
    '@(id: "dest")\n= 远端 Notist\n\n😀中文 *ok*',
  );
  await page.goto("/");
  await connect(page, api.url);
  await page.getByRole("treeitem", { name, exact: true }).click();
  await chooseEditorMode(page, "分栏");
  const preview = page.getByRole("region", { name: "文档预览" });
  await expect(preview.locator("h1")).toHaveText("Remote initial");
  await workerEvaluate(
    page,
    () => {
      (self as any).holdUpdateReplies = true;
    },
    undefined,
    -1,
  );
  try {
    await editor(page).focus();
    await page.keyboard.press("Control+Home");
    await page.keyboard.press("Home");
    await page.keyboard.press("Shift+End");
    await page.keyboard.insertText("# Remote draft");
    await expect(preview.locator("h1")).toHaveText("Remote draft");
    await expect
      .poll(() =>
        workerEvaluate(
          page,
          () => (self as any).heldUpdateReplies?.length ?? 0,
          undefined,
          -1,
        ),
      )
      .toBeGreaterThan(0);
    await page.keyboard.insertText(" accepted");
    await expect(preview.locator("h1")).toHaveText("Remote draft accepted");

    expect(await readFile(join(api.root, "notes", name), "utf8")).toBe(source);
    await preview.locator("h2").first().click();
    await expect(editor(page)).toBeFocused();
    await expect
      .poll(() => page.evaluate(() => window.getSelection()?.toString()))
      .toContain("Remote Section 0");
    await expectEditorMode(page, "分栏");
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
    await workerEvaluate(
      page,
      () => {
        (self as any).holdUpdateReplies = false;
        for (const reply of (self as any).heldUpdateReplies ?? []) reply();
        (self as any).heldUpdateReplies = [];
      },
      undefined,
      -1,
    );
  }
  await page.keyboard.press("Control+s");
  await expect(page.getByRole("status", { name: "保存状态" })).toHaveText(
    "已保存",
  );
  expect(await readFile(join(api.root, "notes", name), "utf8")).toContain(
    "# Remote draft",
  );
  await expect(page.getByRole("status", { name: "预览状态" })).toHaveText(
    "预览已更新",
  );
  // Saving invalidates project resources; a displayed ticket can expire while
  // its replacement is compiling. Retry navigation once the new result arrives.
  await expect(async () => {
    if (
      await page
        .getByRole("tab", { name: "remote-note.not", exact: true })
        .count()
    )
      return;
    await preview.getByRole("link", { name: "go to Notist" }).click();
    await expect(
      page.getByRole("tab", { name: "remote-note.not", exact: true }),
    ).toBeVisible({ timeout: 500 });
  }).toPass();
  await expect(preview.locator("h1")).toHaveText("远端 Notist");
  await expect(preview.locator("strong")).toHaveText("ok");
  await preview.locator("strong").click();
  await expect(editor(page)).toBeFocused();
  await expect
    .poll(() => page.evaluate(() => window.getSelection()?.toString()))
    .toBe("ok");
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
  const source = await readFile(
    join(api.root, "notes", "packaged/package.not"),
    "utf8",
  );
  await page.goto("/");
  await connect(page, api.url);
  await page
    .getByRole("treeitem", { name: "packaged", exact: true })
    .getByRole("button", { name: "展开" })
    .click();
  await page
    .getByRole("treeitem", { name: "package.not", exact: true })
    .click();
  await chooseEditorMode(page, "分栏");
  const preview = page.getByRole("region", { name: "文档预览" });
  await expect(preview.locator("[notist-protocol] strong")).toHaveText(
    "默认标题",
  );
  await expect(
    preview.locator("[notist-protocol] p").filter({ hasText: "WASM" }),
  ).toHaveText("相对 JS / WASM 42");
  const declaration = join(
    api.root,
    "notes",
    "packaged/packages/demo/lib.notc",
  );
  await writeFile(
    declaration,
    'fn card(title: String = "远端声明更新")[children: BlockContent] -> BlockContent;',
  );
  await expect(preview.locator("[notist-protocol] strong")).toHaveText(
    "远端声明更新",
  );
  await writeFile(declaration, "fn card(");
  await expect(page.getByRole("status", { name: "预览状态" })).toHaveText(
    "预览失败",
  );
  await expect(preview.locator("[notist-protocol] strong")).toHaveText(
    "远端声明更新",
  );
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
  expect(
    (await hostDocuments(api)).find(
      (document) => document.path === "packaged/package.not",
    )?.snapshot.text,
  ).toBe(source);
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
      path === "package.not"
        ? new TextDecoder()
            .decode(data)
            .replace(
              "./packages/demo/lib.notc",
              "../external-packages/demo/lib.notc",
            )
        : data,
    );
  }
  const bridge = join(api.root, "external-packages/bridge");
  await mkdir(bridge, { recursive: true });
  await writeFile(join(bridge, "lib.notc"), "fn unused() -> BlockContent;");
  const declaration = join(api.root, "external-packages/demo/lib.notc");
  const transitiveImport = 'import "../bridge/lib.notc" as bridge;\n';
  await writeFile(
    declaration,
    transitiveImport + (await readFile(declaration, "utf8")),
  );
  const source = await readFile(join(api.root, "work/external.not"), "utf8");
  await page.goto("/");
  await connect(page, api.urls.work);
  await page
    .getByRole("treeitem", { name: "external.not", exact: true })
    .click();
  await chooseEditorMode(page, "分栏");
  const preview = page.getByRole("region", { name: "文档预览" });
  await expect(preview.locator("[notist-protocol] strong")).toHaveText(
    "默认标题",
  );
  await expect(
    preview.locator("[notist-protocol] p").filter({ hasText: "WASM" }),
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
  await writeFile(
    declaration,
    transitiveImport +
      'fn card(title: String = "外部声明更新")[children: BlockContent] -> BlockContent;',
  );
  await expect(preview.locator("[notist-protocol] strong")).toHaveText(
    "外部声明更新",
  );
  await writeFile(declaration, "fn card(");
  await expect(page.getByRole("status", { name: "预览状态" })).toHaveText(
    "预览失败",
  );
  await expect(preview.locator("[notist-protocol] strong")).toHaveText(
    "外部声明更新",
  );
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
    transitiveImport +
      'fn card(title: String = "声明恢复")[children: BlockContent] -> BlockContent;',
  );
  await expect(preview.locator("[notist-protocol] strong")).toHaveText(
    "声明恢复",
  );
  await writeFile(join(bridge, "lib.notc"), "fn bridge(");
  await expect(page.getByRole("status", { name: "预览状态" })).toHaveText(
    "预览失败",
  );
  await expect(preview.locator("[notist-protocol] strong")).toHaveText(
    "声明恢复",
  );
  await preview.locator("summary").click();
  await preview
    .getByRole("button")
    .filter({ hasText: "/external-packages/bridge/lib.notc:" })
    .first()
    .click();
  await expect(
    preview.getByRole("region", { name: "package 诊断源码" }),
  ).toContainText("fn bridge(");
  await expect(
    page.getByRole("tab", { name: "external.not", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  const documents = await hostDocuments(api, "work");
  expect(
    documents.some(
      (document) =>
        document.path.includes("external-packages") ||
        document.path.endsWith("lib.notc"),
    ),
  ).toBe(false);
  expect(
    documents.find((document) => document.path === "external.not")?.snapshot
      .text,
  ).toBe(source);
});

test("connection records restore share credentials on reload; removing a connection keeps server files", async ({
  page,
  api,
}) => {
  await page.goto("/");
  await connect(page, api.url);
  await connect(page, api.url + "/");
  let menu = await openVaultMenu(page);
  await expect(menu.getByRole("menuitemradio")).toHaveCount(2);
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
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
  await expect(vaultSwitcher(page)).toHaveAttribute(
    "data-vault-id",
    "opfs:default",
  );
  menu = await openVaultMenu(page);
  await expect(menu.getByRole("menuitemradio")).toHaveCount(2);
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await selectVault(page, "notes");
  await expect(
    page.getByRole("treeitem", { name: "a.md", exact: true }),
  ).toBeVisible();
  const dialog = await openVaultManager(page);
  await expect(dialog).toContainText("保存在此浏览器");
  await expect(
    dialog.getByRole("button", { name: "移除连接 我的 Vault" }),
  ).toHaveCount(0);
  await dialog.getByRole("button", { name: "移除连接 notes" }).click();
  await expect(dialog).toContainText("会确认编辑已发送并关闭当前会话");
  await expect(dialog).toContainText("不会将更改保存到服务器磁盘");
  await expect(dialog).not.toContainText("会先保存已打开的文件");
  await dialog
    .getByRole("button", { name: "确认移除连接", exact: true })
    .click();
  await expect(dialog).toBeHidden();
  await openVaultManager(page);
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
  await expectActiveVault(page, "readonly · 只读");
  await expect(
    page.getByRole("button", { name: "新建笔记", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "文件操作", exact: true }).click();
  for (const name of ["新建文件", "新建文件夹", "导入文件"])
    await expect(
      page.getByRole("menuitem", { name, exact: true }),
    ).toHaveAttribute("aria-disabled", "true");
  await expect(
    page.getByRole("menuitem", { name: "刷新文件树", exact: true }),
  ).not.toHaveAttribute("aria-disabled", "true");
  await page.keyboard.press("Escape");
  const file = page.getByRole("treeitem", { name: "a.md", exact: true });
  await file.click({ button: "right" });
  for (const name of ["重命名…", "剪切", "移动到…", "粘贴", "删除…"])
    await expect(
      page.getByRole("menuitem", { name, exact: false }),
    ).toHaveAttribute("aria-disabled", "true");
  await expect(
    page.getByRole("menuitem", { name: "打开", exact: false }),
  ).not.toHaveAttribute("aria-disabled", "true");
  await expect(
    page.getByRole("menuitem", { name: "下载", exact: true }),
  ).not.toHaveAttribute("aria-disabled", "true");
  await page.getByRole("menuitem", { name: "复制", exact: false }).click();
  await expect(page.getByRole("status", { name: "文件树状态" })).toContainText(
    "已复制 1 项",
  );
  const tree = page.getByRole("tree", { name: "文件树", exact: true });
  await tree.focus();
  for (const key of ["F2", "Delete", "Control+v", "Control+x"])
    await page.keyboard.press(key);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await tree.evaluate((element) => {
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(
      new File(["must not import"], "blocked-import.md", {
        type: "text/markdown",
      }),
    );
    element.dispatchEvent(
      new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer }),
    );
  });
  await file.click({ button: "right" });
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("menuitem", { name: "下载", exact: true }).click();
  expect((await downloadPromise).suggestedFilename()).toBe("a.md");
  await file.click();
  await expect(editor(page)).toHaveAttribute("contenteditable", "false");
  await expect(
    page.getByText("当前 Vault 只读。", { exact: true }),
  ).toBeVisible();
  await chooseEditorMode(page, "分栏");
  await expect(
    page.getByRole("region", { name: "文档预览" }).locator("h1"),
  ).toHaveText("readonly original");
  await expect(editor(page)).toHaveAttribute("contenteditable", "false");
  await expect(
    page.getByRole("treeitem", { name: "blocked-import.md", exact: true }),
  ).toHaveCount(0);
  expect(await readFile(join(api.root, "readonly", "a.md"), "utf8")).toBe(
    "# readonly original\n",
  );
});

test("same-name Vault connections distinguish source and access in the switcher", async ({
  page,
  api,
}) => {
  await page.goto("/");
  await connect(page, api.url);
  await connect(page, api.urls.reader);
  const host = new URL(api.url).host;
  const menu = await openVaultMenu(page);
  await expect(menu.getByRole("menuitemradio")).toHaveText([
    "我的 Vault",
    `notes · ${host} · 可编辑`,
    `notes · ${host} · 只读`,
  ]);
  await expect(
    menu.getByRole("menuitemradio", {
      name: `notes · ${host} · 只读`,
      exact: true,
    }),
  ).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  const dialog = await openVaultManager(page);
  const readonly = dialog.getByRole("listitem").filter({ hasText: "只读" });
  await readonly.getByRole("button", { name: "移除连接 notes" }).click();
  await expect(dialog).toContainText("会关闭当前会话，服务器上的文件仍保留");
  await expect(dialog).not.toContainText("会先保存已打开的文件");
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
    await chooseEditorMode(reader, "分栏");
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
      (await fetch(readerUrl.replace("/ro-", "/") + "/api/v5")).status,
    ).toBe(404);
    const denied = await fetch(
      readerUrl + "/api/v5/file?path=" + name + "&mode=replace",
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

test("unset allowed origins permit browser connections, editing and conditional HTTP writes", async ({
  page,
}) => {
  const root = await mkdtemp(join(tmpdir(), "celestite-cors-"));
  let child: ChildProcess | undefined;
  try {
    await mkdir(join(root, "notes"));
    await writeFile(join(root, "notes", "a.md"), "# Original");
    await writeFile(join(root, "notes", "transport.txt"), "before");
    child = spawn(
      binary,
      [
        "--no-config",
        "--vault",
        "notes",
        "--listen",
        "0.0.0.0:0",
        "--share-key",
        "0",
      ],
      { cwd: root, stdio: ["ignore", "pipe", "pipe"] },
    );
    let log = "";
    child.stderr?.on("data", (bytes) => (log += String(bytes)));
    await expect
      .poll(
        () => {
          if (child!.exitCode !== null || child!.signalCode !== null)
            throw new Error(`server exited: ${log}`);
          return log.includes("Celestite server listening");
        },
        { timeout: 10000 },
      )
      .toBe(true);
    const url = new URL(startupLinks(log).edit);
    url.hostname = "127.0.0.1";
    await page.goto("/");
    await connect(page, url.href);
    await page.getByRole("treeitem", { name: "a.md", exact: true }).click();
    await expect(editor(page)).toHaveText("# Original");
    await editor(page).fill("# Saved from browser");
    await page.keyboard.press("Control+s");
    await expect
      .poll(() => readFile(join(root, "notes", "a.md"), "utf8"))
      .toBe("# Saved from browser");

    // Run in the browser so CORS preflight and ETag visibility are enforced.
    const result = await page.evaluate(async (url) => {
      const module = "/src/lib/vault/http.ts";
      const { openHttpVault } = (await import(
        module
      )) as typeof import("../src/lib/vault/http");
      const { backend } = await openHttpVault(url);
      try {
        const path = "transport.txt" as import("../src/lib/vault").VaultPath;
        const snapshot = await backend.readFileSnapshot(path);
        const revision = await backend.writeFile(
          path,
          new TextEncoder().encode("after"),
          { mode: "replace", expectedRevision: snapshot.revision },
        );
        return {
          changed: revision !== snapshot.revision,
          text: new TextDecoder().decode(await backend.readFile(path)),
        };
      } finally {
        await backend.close();
      }
    }, url.href);
    expect(result).toEqual({ changed: true, text: "after" });
    expect(await readFile(join(root, "notes", "transport.txt"), "utf8")).toBe(
      "after",
    );
  } finally {
    await page.close();
    if (child && child.exitCode === null && child.signalCode === null) {
      const process = child;
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => process.kill("SIGKILL"), 5000);
        process.once("exit", () => {
          clearTimeout(timeout);
          resolve();
        });
        process.kill("SIGTERM");
      });
    }
    await rm(root, { recursive: true, force: true });
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
    const identity = (await (await fetch(before.edit + "/api/v5")).json())
      .vault;
    await page.goto("/");
    await connect(page, before.edit);
    await page.getByRole("treeitem", { name: "a.md", exact: true }).click();
    await editor(page).fill("# Preserved shared draft");
    await expect
      .poll(async () => {
        const documents = await (
          await fetch(before.edit + "/api/v5/documents")
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
      expect((await fetch(old + "/api/v5")).status).toBe(404);
    const rotatedIdentity = (await (await fetch(after.edit + "/api/v5")).json())
      .vault;
    expect(rotatedIdentity.vaultId).not.toBe(identity.vaultId);
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
  await chooseEditorMode(page, "分栏");
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
  await page.context().route(api.url + "/api/v5", async (route) => {
    const response = await route.fetch();
    const descriptor = await response.json();
    descriptor.vault.historyId = "another-host-history";
    await route.fulfill({ response, json: descriptor });
  });
  const dialog = await openVaultManager(page);
  await dialog.getByLabel("连接远端 Vault", { exact: true }).fill(api.url);
  await dialog.getByRole("button", { name: "连接", exact: true }).click();
  await expect(dialog).toContainText("远端 Vault 历史已改变");
  await dialog.getByRole("button", { name: "关闭弹窗", exact: true }).click();
  await expect(editor(page)).toHaveAttribute("contenteditable", "false");
  await expect(editor(page)).toHaveText("# Keep this draft");
  expect(await readFile(join(api.root, "notes", name), "utf8")).toBe(
    "# Original",
  );
  await page.context().unroute(api.url + "/api/v5");

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
  const dialog = await openVaultManager(page);
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
  await expect(page.getByRole("status", { name: "保存状态" })).toHaveText(
    "编辑需要恢复",
  );
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
    const dialog = await openVaultManager(page);
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
    await expect(dialog).toBeHidden();
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
  await openNavigation(page);
  const dialog = await openVaultManager(page);
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
  await fileAction(page, "新建文件夹");
  await page.getByRole("textbox", { name: "名称", exact: true }).fill("drafts");
  await page.getByRole("button", { name: "确认", exact: true }).click();
  await expect(
    page.getByRole("treeitem", { name: "drafts", exact: true }),
  ).toBeVisible();
  await fileAction(page, "新建文件");
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
    page.getByRole("button", { name: "添加实例", exact: true }),
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
    page.getByRole("button", { name: "添加实例", exact: true }),
  ).toBeEnabled();
  await a.getByRole("textbox").fill("A😀aB");
  await expect(b.getByRole("textbox")).toHaveValue("A😀aB");
  await b.getByRole("textbox").fill("A😀abB");
  await expect(
    page.getByRole("button", { name: "添加实例", exact: true }),
  ).toBeEnabled();
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
  await expect(page.getByRole("status", { name: "收敛状态" })).toHaveText(
    "因果版本已收敛",
  );
  for (const region of [a, b, c])
    await expect(region.getByRole("textbox")).toHaveValue("A😀bB");
  await a.getByRole("button", { name: "保存到文件", exact: true }).click();
  await expect(a.getByRole("status", { name: "实例 A 保存状态" })).toHaveText(
    "文件与正文一致",
  );
  expect(await readFile(join(api.root, "notes", path), "utf8")).toBe("A😀bB");
});

test("sync debug retains a disconnected production replica and rejoins the host history", async ({
  page,
  api,
}) => {
  await installWorkerHarness(page, true);
  const path = `debug-fault-${crypto.randomUUID()}.md`;
  await writeFile(join(api.root, "notes", path), "A😀B");
  await openSyncDebug(page, api, path);
  const a = page.getByRole("region", { name: "实例 A", exact: true });
  const b = page.getByRole("region", { name: "实例 B", exact: true });
  await workerEvaluate(
    page,
    () => {
      (self as any).testSockets.forEach((socket: WebSocket) => socket.close());
    },
    undefined,
    1,
  );
  await expect(
    b.getByRole("button", { name: "重新连接", exact: true }),
  ).toBeEnabled();
  await a.getByRole("textbox").fill("A😀oneB");
  await expect(b.getByRole("textbox")).toHaveValue("A😀B");
  await expect(b.getByRole("textbox")).not.toBeEditable();
  await b.getByRole("button", { name: "重新连接", exact: true }).click();
  await expect(b.getByRole("textbox")).toHaveValue("A😀oneB");
  await expect(page.getByRole("status", { name: "收敛状态" })).toHaveText(
    "因果版本已收敛",
  );
  expect(await readFile(join(api.root, "notes", path), "utf8")).toBe("A😀B");
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
  await expect(page.getByRole("alert")).toContainText("Link not found");
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
    a.getByRole("button", { name: "撤销", exact: true }),
  ).toBeDisabled();
  await expect(
    a.getByRole("button", { name: "保存到文件", exact: true }),
  ).toBeDisabled();
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
  await expect(b).toHaveValue("A😀B+stream");
  await expect(page.getByRole("status", { name: "收敛状态" })).toHaveText(
    "因果版本已收敛",
  );
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
test("two online editors converge live and undo only their own peer", async ({
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
    const sidebar = await page.locator(".workspace-sidebar").boundingBox();
    const point = {
      x: (sidebar ?? content).x + 24,
      y: (sidebar ?? content).y + 24,
    };
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
    await expect(vaultSwitcher(page)).toBeVisible();
    await overlay
      .getByRole("button", { name: "尝试重新连接", exact: true })
      .click();
    await expect(overlay).toHaveCount(0);
    await expect(page.locator(".workspace-content-body[inert]")).toHaveCount(0);
    await expect(page.getByRole("menu")).toHaveCount(0);
    if (surface === "mobile-editor") {
      await expect(editor(page)).toHaveAttribute("contenteditable", "true");
      await page
        .getByRole("button", { name: "切换文件导航", exact: true })
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
      const identity = (await (await fetch(api.url + "/api/v5", {})).json())
        .vault;
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
        await (await fetch(api.url + "/api/v5", {})).json()
      ).vault;
      expect(recoveredIdentity.vaultId).toBe(identity.vaultId);
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

test("document leases release presence, keep undo on reopen, and permit path reuse and reconnect", async ({
  page,
  api,
}) => {
  await installWorkerHarness(page, true);
  const a = `lease-a-${crypto.randomUUID()}.md`;
  const b = `lease-b-${crypto.randomUUID()}.md`;
  await writeFile(join(api.root, "notes", a), "seed");
  await writeFile(join(api.root, "notes", b), "other");
  await page.goto("/");
  await connect(page, api.url);
  const mine = () =>
    page.evaluate(() => {
      const events = (window as any).editorMessages as any[];
      const state = events
        .filter((event) => event.kind === "members" && event.state)
        .at(-1)?.state;
      return state?.members.find(
        (member: any) => member.sessionId === state.sessionId,
      );
    });
  await page.getByRole("treeitem", { name: a, exact: true }).click();
  await editor(page).focus();
  await page.keyboard.press("Control+End");
  await page.keyboard.insertText(" local");
  await expect(editor(page)).toHaveText("seed local");
  await expect
    .poll(
      async () =>
        (await mine())?.views.filter((view: any) => view.focused).length ?? 0,
    )
    .toBe(1);
  await page.getByRole("button", { name: `关闭 ${a}`, exact: true }).click();
  await expect.poll(async () => (await mine())?.documents.length).toBe(0);
  await expect.poll(async () => (await mine())?.views.length).toBe(0);
  expect(await readFile(join(api.root, "notes", a), "utf8")).toBe("seed");
  await writeFile(join(api.root, "notes", a), "prefix seed");
  await page.getByRole("treeitem", { name: a, exact: true }).click();
  await expect(editor(page)).toHaveText("prefix seed local");
  await editor(page).focus();
  await page.keyboard.press("Control+z");
  await expect(editor(page)).toHaveText("prefix seed");
  await page.getByRole("button", { name: `关闭 ${a}`, exact: true }).click();
  await expect.poll(async () => (await mine())?.documents.length).toBe(0);
  const removed = await fetch(
    `${api.url}/api/v5/entry?path=${encodeURIComponent(a)}`,
    { method: "DELETE" },
  );
  expect(removed.ok).toBe(true);
  await writeFile(join(api.root, "notes", a), "recreated");
  await fileAction(page, "刷新文件树");
  await page.getByRole("treeitem", { name: a, exact: true }).click();
  await expect(editor(page)).toHaveText("recreated");
  await page.getByRole("button", { name: `关闭 ${a}`, exact: true }).click();
  await page.getByRole("treeitem", { name: b, exact: true }).click();
  await expect(editor(page)).toHaveText("other");
  await workerEvaluate(
    page,
    () => {
      (self as any).testSockets.forEach((socket: WebSocket) => socket.close());
    },
    undefined,
    -1,
  );
  await page.getByRole("button", { name: "尝试重新连接", exact: true }).click();
  await expect(editor(page)).toHaveText("other");
  await page.getByRole("treeitem", { name: a, exact: true }).click();
  await expect(editor(page)).toHaveText("recreated");
  await expect.poll(async () => (await mine())?.documents.length).toBe(2);
});

test("collaboration renders Unicode selections and read-only members, maps concurrent edits, and clears released views", async ({
  page,
  browser,
  api,
}) => {
  const name = `presence-${crypto.randomUUID()}.md`;
  const disk = join(api.root, "notes", name);
  await writeFile(disk, "A😀BC");
  await installWorkerHarness(page, true);
  await page.goto("/");
  await connect(page, api.url);
  await page.getByRole("treeitem", { name, exact: true }).click();
  const context = await browser.newContext();
  const readerContext = await browser.newContext();
  try {
    const other = await context.newPage();
    const reader = await readerContext.newPage();
    await other.goto(new URL("/", page.url()).href);
    await connect(other, api.url);
    await other.getByRole("treeitem", { name, exact: true }).click();
    await reader.goto(new URL("/", page.url()).href);
    await connect(reader, api.urls.reader);
    await reader.getByRole("treeitem", { name, exact: true }).click();
    await expect(
      other.getByRole("status", { name: "在线成员", exact: true }),
    ).toHaveText("3 人在线 · 3 人查看本文档");
    await other
      .getByLabel("协作成员", { exact: true })
      .locator("summary")
      .click();
    await expect(
      other.getByRole("list", { name: "在线成员列表" }),
    ).toContainText("只读");
    const sessionId = await page.evaluate(() => {
      const events = (window as any).editorMessages as any[];
      return events
        .filter((event) => event.kind === "members" && event.state)
        .at(-1).state.sessionId as string;
    });
    const remoteCursor = other.locator(
      `.cm-collaborator-cursor[data-member-id="${sessionId}"]`,
    );
    const remoteSelection = other.locator(
      `.cm-collaborator-selection[data-member-id="${sessionId}"]`,
    );
    await editor(page).focus();
    await page.keyboard.press("Control+Home");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Shift+ArrowRight");
    await page.keyboard.press("Shift+ArrowRight");
    await expect(remoteSelection).toHaveText("😀B");
    await expect(remoteCursor).toHaveAttribute("data-offset", "4");
    await expect(editor(other)).toHaveText("A😀BC");
    await editor(other).focus();
    await other.keyboard.press("Control+Home");
    await other.keyboard.insertText("前");
    for (const peer of [page, other, reader])
      await expect(editor(peer)).toHaveText("前A😀BC");
    await expect(remoteSelection).toHaveText("😀B");
    await expect(remoteCursor).toHaveAttribute("data-offset", "5");
    expect(await readFile(disk, "utf8")).toBe("A😀BC");
    await page
      .getByRole("button", { name: `关闭 ${name}`, exact: true })
      .click();
    await expect(remoteCursor).toHaveCount(0);
    await expect(remoteSelection).toHaveCount(0);
    await expect(
      other.getByRole("status", { name: "在线成员", exact: true }),
    ).toHaveText("3 人在线 · 2 人查看本文档");
    await readerContext.close();
    await expect(
      other.getByRole("status", { name: "在线成员", exact: true }),
    ).toHaveText("2 人在线 · 1 人查看本文档");
  } finally {
    await context.close();
    await readerContext.close();
  }
});

test("live presentation keeps concurrent remote source and reveals ranges containing collaborator cursors", async ({
  page,
  browser,
  api,
}, testInfo) => {
  const name = `live-collaboration-${crypto.randomUUID()}.md`;
  const original =
    "# Shared 😀\n\n**bold** and *soft* [link](a.md)\n\nleft middle right";
  await writeFile(join(api.root, "notes", name), original);
  const context = await browser.newContext({
    baseURL: String(testInfo.project.use.baseURL),
  });
  const other = await context.newPage();
  let holdingReplies = false;
  const errors: string[] = [];
  other.on("pageerror", (error) => errors.push(error.message));
  const documentText = (client: Page) =>
    editor(client).evaluate(
      (element) =>
        (element as any).cmTile.root.view.state.doc.toString() as string,
    );
  const position = (client: Page, offset: number) =>
    editor(client).evaluate((element, offset) => {
      const view = (element as any).cmTile.root.view;
      view.dispatch({ selection: { anchor: offset } });
    }, offset);
  try {
    for (const client of [page, other]) {
      await installWorkerHarness(client, true);
      await client.goto("/");
      await connect(client, api.url);
      await client.getByRole("treeitem", { name, exact: true }).click();
      await chooseEditorMode(client, "实时渲染");
      await editor(client).focus();
      await position(client, original.length);
      await expect(client.locator(".cm-live-strong").first()).toHaveText(
        "bold",
      );
    }
    // A remote selection is still a source offset. Expose its delimiters rather
    // than painting a collaborator cursor in an invisible source range.
    const marker = original.indexOf("**bold**") + 1;
    await other.bringToFront();
    await editor(other).focus();
    await position(other, marker);
    await expect(page.locator(".cm-collaborator-cursor")).toHaveCount(1);
    await expect(page.locator(".cm-collaborator-cursor")).toHaveAttribute(
      "data-offset",
      String(marker),
    );
    await expect(editor(page)).toContainText("**bold**");
    await expect(
      page.locator('.cm-live-marker-hidden[data-live-kind="strong"]'),
    ).toHaveCount(0);
    await position(other, original.length);
    await expect(page.locator(".cm-live-strong").first()).toHaveText("bold");
    holdingReplies = true;
    for (const client of [page, other])
      await workerEvaluate(
        client,
        () => {
          (self as any).holdUpdateReplies = true;
        },
        undefined,
        -1,
      );
    await editor(page).focus();
    await position(page, original.indexOf("left middle right"));
    await editor(other).focus();
    await position(other, original.length);
    await Promise.all([
      page.keyboard.insertText("**A** "),
      other.keyboard.insertText(" :B"),
    ]);
    const expected = original.replace(
      "left middle right",
      "**A** left middle right :B",
    );
    for (const client of [page, other])
      await expect.poll(() => documentText(client)).toBe(expected);
    await position(page, expected.length);
    await expect(
      page.locator(".cm-live-strong").filter({ hasText: /^A$/ }),
    ).toHaveText("A");
    await expect
      .poll(() =>
        workerEvaluate(
          page,
          () => (self as any).heldUpdateReplies?.length ?? 0,
          undefined,
          -1,
        ),
      )
      .toBeGreaterThan(0);
    expect(await readFile(join(api.root, "notes", name), "utf8")).toBe(
      original,
    );
    for (const client of [page, other])
      await workerEvaluate(
        client,
        () => {
          (self as any).holdUpdateReplies = false;
          for (const reply of (self as any).heldUpdateReplies ?? []) reply();
          (self as any).heldUpdateReplies = [];
        },
        undefined,
        -1,
      );
    await editor(page).focus();
    await page.keyboard.press("Control+z");
    for (const client of [page, other])
      await expect.poll(() => documentText(client)).toBe(original + " :B");
    await page.keyboard.press("Control+y");
    for (const client of [page, other])
      await expect.poll(() => documentText(client)).toBe(expected);
    await page.keyboard.press("Control+s");
    await expect
      .poll(() => readFile(join(api.root, "notes", name), "utf8"))
      .toBe(expected);
    expect(errors).toEqual([]);
  } finally {
    if (holdingReplies)
      await Promise.allSettled(
        [page, other].map((client) =>
          workerEvaluate(
            client,
            () => {
              (self as any).holdUpdateReplies = false;
              for (const reply of (self as any).heldUpdateReplies ?? [])
                reply();
              (self as any).heldUpdateReplies = [];
            },
            undefined,
            -1,
          ),
        ),
      );
    await context.close();
  }
});

test("Android EditContext composition freezes live rendering and defers remote imports through the final input", async ({
  browser,
  api,
}, testInfo) => {
  const name = `edit-context-ime-${crypto.randomUUID()}.md`;
  const original = "# EditContext 😀\n\n**原有粗体**\n\n输入：";
  const composed = "中文 **组合内容**\n\n继续";
  const disk = join(api.root, "notes", name);
  await writeFile(disk, original);
  const context = await browser.newContext({
    baseURL: String(testInfo.project.use.baseURL),
    userAgent: `Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${browser.version()} Mobile Safari/537.36`,
    viewport: { width: 900, height: 800 },
    isMobile: true,
    hasTouch: true,
  });
  const android = await context.newPage();
  const errors: string[] = [];
  android.on("pageerror", (error) => errors.push(error.message));
  type PublicEditContext = EventTarget & {
    text: string;
    selectionStart: number;
    selectionEnd: number;
    updateText(from: number, to: number, text: string): void;
    updateSelection(from: number, to: number): void;
  };
  type PublicTextUpdateConstructor = new (
    type: string,
    init: {
      updateRangeStart: number;
      updateRangeEnd: number;
      text: string;
      selectionStart: number;
      selectionEnd: number;
    },
  ) => Event;
  const documentText = () =>
    editor(android).evaluate(
      (element) =>
        (element as any).cmTile.root.view.state.doc.toString() as string,
    );
  try {
    await android.goto("/");
    await connect(android, api.url);
    await android.getByRole("treeitem", { name, exact: true }).click();
    await chooseEditorMode(android, "实时渲染");
    await editor(android).focus();
    await viewCommand(android, "end");
    await expect(android.locator(".cm-live-strong").first()).toHaveText(
      "原有粗体",
    );
    const capabilities = await editor(android).evaluate((element) => {
      const runtime = window as unknown as {
        EditContext?: unknown;
        TextUpdateEvent?: unknown;
      };
      const editContext = (
        element as HTMLElement & { editContext?: PublicEditContext }
      ).editContext;
      return {
        android: /Android/.test(navigator.userAgent),
        editContext: typeof runtime.EditContext === "function",
        textUpdateEvent: typeof runtime.TextUpdateEvent === "function",
        attached: editContext?.constructor.name === "EditContext",
        text: editContext?.text,
        selection: editContext?.selectionEnd,
      };
    });
    expect(
      capabilities,
      "This Chromium must expose and CodeMirror must attach the real Android EditContext API",
    ).toEqual({
      android: true,
      editContext: true,
      textUpdateEvent: true,
      attached: true,
      text: original,
      selection: original.length,
    });
    await editor(android).evaluate((element) => {
      const control = window as unknown as {
        editContextDomCompositionEvents: number;
      };
      control.editContextDomCompositionEvents = 0;
      element.addEventListener(
        "compositionstart",
        () => control.editContextDomCompositionEvents++,
      );
      element.addEventListener(
        "compositionend",
        () => control.editContextDomCompositionEvents++,
      );
      const editContext = (
        element as HTMLElement & { editContext: PublicEditContext }
      ).editContext;
      editContext.dispatchEvent(new CompositionEvent("compositionstart"));
    });
    // Public updateText/updateSelection mimic the browser's context buffer
    // update, then a real TextUpdateEvent goes through CodeMirror's adapter.
    await editor(android).evaluate(
      (element, { from, text }) => {
        const editContext = (
          element as HTMLElement & { editContext: PublicEditContext }
        ).editContext;
        const { TextUpdateEvent } = window as unknown as {
          TextUpdateEvent: PublicTextUpdateConstructor;
        };
        editContext.updateText(from, from, text);
        editContext.updateSelection(from + text.length, from + text.length);
        editContext.dispatchEvent(
          new TextUpdateEvent("textupdate", {
            updateRangeStart: from,
            updateRangeEnd: from,
            text,
            selectionStart: from + text.length,
            selectionEnd: from + text.length,
          }),
        );
      },
      { from: original.length, text: "中" },
    );
    await expect.poll(documentText).toBe(original + "中");
    await editor(android).evaluate(
      (element, { from, text }) => {
        const editContext = (
          element as HTMLElement & { editContext: PublicEditContext }
        ).editContext;
        const { TextUpdateEvent } = window as unknown as {
          TextUpdateEvent: PublicTextUpdateConstructor;
        };
        editContext.updateText(from, from + 1, text);
        editContext.updateSelection(from + text.length, from + text.length);
        editContext.dispatchEvent(
          new TextUpdateEvent("textupdate", {
            updateRangeStart: from,
            updateRangeEnd: from + 1,
            text,
            selectionStart: from + text.length,
            selectionEnd: from + text.length,
          }),
        );
      },
      { from: original.length, text: composed },
    );
    await expect.poll(documentText).toBe(original + composed);
    await expect
      .poll(
        async () =>
          (await hostDocuments(api)).find((document) => document.path === name)
            ?.snapshot.text,
      )
      .toBe(original + composed);
    await android.waitForTimeout(150);
    await expect(
      android.locator(".cm-line").filter({ hasText: "中文" }),
    ).toHaveText("输入：中文 **组合内容**");
    await expect(
      android.locator(".cm-live-strong").filter({ hasText: "组合内容" }),
    ).toHaveCount(0);
    await writeFile(disk, "外部 " + original);
    await expect
      .poll(
        async () =>
          (await hostDocuments(api)).find((document) => document.path === name)
            ?.snapshot.text,
      )
      .toBe("外部 " + original + composed);
    expect(await documentText()).toBe(original + composed);
    await editor(android).evaluate((element, composed) => {
      const editContext = (
        element as HTMLElement & { editContext: PublicEditContext }
      ).editContext;
      const { TextUpdateEvent } = window as unknown as {
        TextUpdateEvent: PublicTextUpdateConstructor;
      };
      editContext.dispatchEvent(
        new CompositionEvent("compositionend", { data: composed }),
      );
      // Some input methods deliver their final text immediately after end.
      const from = editContext.selectionEnd;
      editContext.updateText(from, from, "！");
      editContext.updateSelection(from + 1, from + 1);
      editContext.dispatchEvent(
        new TextUpdateEvent("textupdate", {
          updateRangeStart: from,
          updateRangeEnd: from,
          text: "！",
          selectionStart: from + 1,
          selectionEnd: from + 1,
        }),
      );
    }, composed);
    const expected = "外部 " + original + composed + "！";
    await expect.poll(documentText).toBe(expected);
    await expect(
      android.locator(".cm-live-strong").filter({ hasText: "组合内容" }),
    ).toHaveText("组合内容");
    expect(
      await editor(android).evaluate(
        (element) =>
          (element as HTMLElement & { editContext: PublicEditContext })
            .editContext.text,
      ),
    ).toBe(expected);
    expect(
      await android.evaluate(
        () =>
          (window as unknown as { editContextDomCompositionEvents: number })
            .editContextDomCompositionEvents,
      ),
    ).toBe(0);
    await android.keyboard.press("Control+s");
    await expect.poll(() => readFile(disk, "utf8")).toBe(expected);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

for (const heldReply of ["none", "syntax", "presence"] as const)
  test(`Android DOM composition retains a final post-end mutation before releasing remote imports${heldReply !== "none" ? ` when a held ${heldReply} reply arrives` : ""}`, async ({
    browser,
    api,
  }, testInfo) => {
    const name = `dom-ime-${crypto.randomUUID()}.md`;
    const original = "# DOM composition 😀\n\n**原有粗体**\n\n输入：";
    const composed = "中文 **末尾输入**\n\n继续";
    const disk = join(api.root, "notes", name);
    await writeFile(disk, original);
    const context = await browser.newContext({
      baseURL: String(testInfo.project.use.baseURL),
      userAgent: `Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${browser.version()} Mobile Safari/537.36`,
      viewport: { width: 900, height: 800 },
      isMobile: true,
      hasTouch: true,
    });
    const android = await context.newPage();
    if (heldReply !== "none")
      await android.addInitScript((mode) => {
        const NativeWorker = window.Worker;
        const control = {
          hold: false,
          replies: [] as (() => void)[],
          peerId: "",
          closedView: false,
          sequences: [] as {
            stage: "received" | "held" | "delivered";
            sequence: number;
            kind: string;
          }[],
        };
        (
          window as unknown as {
            compositionReplies: typeof control;
          }
        ).compositionReplies = control;
        window.Worker = class extends NativeWorker {
          private syntax: boolean;
          constructor(url: string | URL, options?: WorkerOptions) {
            super(url, options);
            this.syntax = /\/lib\/syntax\/worker\.ts(?:\?|$)/.test(String(url));
            if (
              mode === "presence" &&
              /\/lib\/editor\/remote\/worker\.ts(?:\?|$)/.test(String(url))
            ) {
              const subscribe = this.addEventListener.bind(this);
              const unsubscribe = this.removeEventListener.bind(this);
              const listeners = new Map<
                EventListenerOrEventListenerObject,
                EventListener
              >();
              this.addEventListener = ((
                type: string,
                handler: EventListenerOrEventListenerObject,
                options?: boolean | AddEventListenerOptions,
              ) => {
                if (type !== "message")
                  return subscribe(type, handler, options);
                let wrapped = listeners.get(handler);
                if (!wrapped) {
                  wrapped = (event) => {
                    const message = (event as MessageEvent).data;
                    const sequenced = typeof message?.sequence === "number";
                    const log = (stage: "received" | "held" | "delivered") => {
                      if (sequenced)
                        control.sequences.push({
                          stage,
                          sequence: message.sequence,
                          kind: message.kind,
                        });
                    };
                    log("received");
                    const deliver = () => {
                      log("delivered");
                      if (typeof handler === "function")
                        handler.call(this, event);
                      else handler.handleEvent(event);
                    };
                    // Preserve the shared notification FIFO after members;
                    // request replies continue to their real callback at once.
                    if (
                      !control.hold ||
                      !sequenced ||
                      (!control.replies.length && message.kind !== "members")
                    )
                      return deliver();
                    log("held");
                    if (message.kind === "members")
                      control.closedView ||= !!message.state?.members.some(
                        (member: { sessionId: string; views: unknown[] }) =>
                          member.sessionId === control.peerId &&
                          !member.views.length,
                      );
                    control.replies.push(deliver);
                  };
                  listeners.set(handler, wrapped);
                }
                subscribe(type, wrapped, options);
              }) as Worker["addEventListener"];
              this.removeEventListener = ((
                type: string,
                handler: EventListenerOrEventListenerObject,
                options?: boolean | EventListenerOptions,
              ) => {
                unsubscribe(
                  type,
                  type === "message"
                    ? (listeners.get(handler) ?? handler)
                    : handler,
                  options,
                );
                if (type === "message") listeners.delete(handler);
              }) as Worker["removeEventListener"];
            }
          }
          set onmessage(
            handler: ((this: Worker, event: MessageEvent) => void) | null,
          ) {
            if (mode !== "syntax" || !this.syntax) {
              super.onmessage = handler;
              return;
            }
            // Queue the actual browser MessageEvent and application callback;
            // parsing and the worker's response remain entirely real.
            super.onmessage = (event) => {
              if (!handler) return;
              const deliver = () => handler.call(this, event);
              if (control.hold) control.replies.push(deliver);
              else deliver();
            };
          }
        };
      }, heldReply);
    const peerContext =
      heldReply === "presence"
        ? await browser.newContext({
            baseURL: String(testInfo.project.use.baseURL),
          })
        : undefined;
    const peer = await peerContext?.newPage();
    const errors: string[] = [];
    android.on("pageerror", (error) => errors.push(error.message));
    const documentText = () =>
      editor(android).evaluate(
        (element) =>
          (element as any).cmTile.root.view.state.doc.toString() as string,
      );
    try {
      await android.goto("/");
      await connect(android, api.url);
      // Configure the public constructor before creating the tested view. The
      // warm-up document gives us the application's exact CodeMirror instance.
      await android
        .getByRole("treeitem", { name: "a.md", exact: true })
        .click();
      await editor(android).evaluate((element) => {
        const view = (element as any).cmTile.root.view;
        (view.constructor as { EDIT_CONTEXT?: boolean }).EDIT_CONTEXT = false;
      });
      await android.getByRole("treeitem", { name, exact: true }).click();
      await chooseEditorMode(android, "实时渲染");
      await editor(android).focus();
      await viewCommand(android, "end");
      expect(
        await editor(android).evaluate(
          (element) =>
            (element as HTMLElement & { editContext?: EventTarget | null })
              .editContext ?? null,
        ),
      ).toBeNull();
      await expect(android.locator(".cm-live-strong").first()).toHaveText(
        "原有粗体",
      );
      if (peer) {
        peer.on("pageerror", (error) => errors.push(error.message));
        await peer.goto("/");
        await connect(peer, api.url);
        await peer.getByRole("treeitem", { name, exact: true }).click();
        await editor(peer).focus();
        await viewCommand(peer, "start");
        await android.bringToFront();
        await editor(android).focus();
        const remoteCursor = android.locator(".cm-collaborator-cursor");
        await expect(remoteCursor).toHaveCount(1);
        const peerId = await remoteCursor.getAttribute("data-member-id");
        expect(peerId).toBeTruthy();
        await android.evaluate((peerId) => {
          (
            window as unknown as {
              compositionReplies: { peerId: string };
            }
          ).compositionReplies.peerId = peerId!;
        }, peerId);
      }
      if (heldReply === "syntax")
        await android.evaluate(() => {
          (
            window as unknown as {
              compositionReplies: { hold: boolean };
            }
          ).compositionReplies.hold = true;
        });
      await editor(android).dispatchEvent("compositionstart");
      await android.keyboard.insertText(composed);
      await expect.poll(documentText).toBe(original + composed);
      await expect
        .poll(
          async () =>
            (await hostDocuments(api)).find(
              (document) => document.path === name,
            )?.snapshot.text,
        )
        .toBe(original + composed);
      if (heldReply === "syntax")
        await expect
          .poll(() =>
            android.evaluate(
              () =>
                (
                  window as unknown as {
                    compositionReplies: { replies: (() => void)[] };
                  }
                ).compositionReplies.replies.length,
            ),
          )
          .toBeGreaterThan(0);
      else await android.waitForTimeout(150);
      await expect(
        android.locator(".cm-live-strong").filter({ hasText: "末尾输入" }),
      ).toHaveCount(0);
      await writeFile(disk, "外部 " + original);
      await expect
        .poll(
          async () =>
            (await hostDocuments(api)).find(
              (document) => document.path === name,
            )?.snapshot.text,
        )
        .toBe("外部 " + original + composed);
      expect(await documentText()).toBe(original + composed);
      if (peer) {
        await android.evaluate(() => {
          (
            window as unknown as {
              compositionReplies: { hold: boolean };
            }
          ).compositionReplies.hold = true;
        });
        // Closing a real peer view clears an already displayed cursor directly
        // from members, avoiding an extra asynchronous anchor-resolution hop.
        await peer
          .getByRole("button", { name: `关闭 ${name}`, exact: true })
          .click();
        await android.bringToFront();
        await editor(android).focus();
        await expect
          .poll(() =>
            android.evaluate(
              () =>
                (
                  window as unknown as {
                    compositionReplies: { closedView: boolean };
                  }
                ).compositionReplies.closedView,
            ),
          )
          .toBe(true);
      }
      const released = await editor(android).evaluate(
        async (element, { text, releaseReply }) => {
          // Start just after a real frame, so CodeMirror's Android end flush is
          // scheduled for the next frame rather than racing a frame already due.
          await new Promise<void>((resolve) =>
            requestAnimationFrame(() => resolve()),
          );
          element.dispatchEvent(
            new CompositionEvent("compositionend", {
              data: text,
              bubbles: true,
            }),
          );
          // The browser may commit its final DOM mutation after compositionend.
          // Use DOM/InputEvent only; no EditorView transaction or private observer.
          const line = element.querySelector(".cm-line:last-child")!;
          const final = document.createTextNode("！");
          line.appendChild(final);
          window.getSelection()!.collapse(final, final.length);
          element.dispatchEvent(
            new InputEvent("input", {
              inputType: "insertText",
              data: "！",
              bubbles: true,
            }),
          );
          if (!releaseReply) return 0;
          const control = (
            window as unknown as {
              compositionReplies: { hold: boolean; replies: (() => void)[] };
            }
          ).compositionReplies;
          control.hold = false;
          const replies = control.replies.splice(0);
          // Deliver after the final DOM mutation but before the next animation
          // frame, while CodeMirror still holds the pre-commit document version.
          for (const deliver of replies) deliver();
          return replies.length;
        },
        { text: composed, releaseReply: heldReply !== "none" },
      );
      if (heldReply !== "none") expect(released).toBeGreaterThan(0);
      if (peer) {
        const sequences = await android.evaluate(
          () =>
            (
              window as unknown as {
                compositionReplies: {
                  sequences: {
                    stage: string;
                    sequence: number;
                    kind: string;
                  }[];
                };
              }
            ).compositionReplies.sequences,
        );
        await testInfo.attach("presence-worker-sequences", {
          body: JSON.stringify(sequences, null, 2),
          contentType: "application/json",
        });
        const received = sequences
          .filter(({ stage }) => stage === "received")
          .map(({ sequence }) => sequence);
        const delivered = sequences
          .filter(({ stage }) => stage === "delivered")
          .map(({ sequence }) => sequence);
        expect(delivered).toEqual(received);
        expect(received).toEqual(
          received.map((_, index) => received[0]! + index),
        );
      }
      await expect(
        android.getByRole("region", { name: "远端连接状态" }),
      ).toHaveCount(0);
      const expected = "外部 " + original + composed + "！";
      await expect.poll(documentText).toBe(expected);
      await expect(
        android.locator(".cm-live-strong").filter({ hasText: "末尾输入" }),
      ).toHaveText("末尾输入");
      if (peer)
        await expect(android.locator(".cm-collaborator-cursor")).toHaveCount(0);
      await android.keyboard.press("Control+s");
      await expect.poll(() => readFile(disk, "utf8")).toBe(expected);
      await expect(
        android.getByRole("region", { name: "远端连接状态" }),
      ).toHaveCount(0);
      expect(errors).toEqual([]);
    } finally {
      await peerContext?.close();
      await context.close();
    }
  });
