import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EditorBinding,
  PreviewBinding,
  preview_resource_requests,
  render_preview,
} from "../../src/lib/editor/generated/celestite_core";
import { nativePreviewExecutor } from "../../src/lib/desktop/preview";
import { nativeLanguageWorker } from "../../src/lib/desktop/language";
import type { LanguageWorkerReply } from "../../src/lib/language/protocol";
import {
  openNativeEditor,
  openNativeRemoteEditor,
} from "../../src/lib/desktop/editor";
import { nativeExternalUrl } from "../../src/lib/desktop/platform";
import type { DesktopInvoke } from "../../src/lib/desktop/platform";
import { TaskQueue } from "../../src/lib/editor/queue";
import { createBrowserIo } from "../../src/lib/editor/local/io";
import type { VaultBackend } from "../../src/lib/vault/types";
import { VaultError } from "../../src/lib/vault/errors";
import { vaultPath } from "../../src/lib/vault/path";
import { MemoryRecoveryFiles, replaceText, coreReady } from "./core-runtime";
import {
  absoluteResourcePath,
  previewModulePath,
  nativeComponentUrl,
} from "../../src/lib/preview/path";
import { PreviewResources } from "../../src/lib/preview/resources";
import type {
  PreviewState,
  PreviewTask,
  ResourceContext,
} from "../../src/lib/preview/contract";
import { VaultManager } from "../../src/lib/vault/manager";
import { openAppDocument } from "../../src/lib/settings/app-file";
import { shutdownDesktopWorkspace } from "../../src/lib/desktop/shutdown";
import { downloadBytes } from "../../src/lib/download";
import type { SettingsFile } from "../../src/lib/settings/app-file";
import { FileTreeModel } from "../../src/lib/file-tree/model";
import { HttpVaultBackend } from "../../src/lib/vault/http";

const baseIdentity = {
  instanceId: "desktop-test",
  vault: { vaultId: "vault", historyId: "history" },
};
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
async function until(check: () => boolean) {
  for (let i = 0; i < 500; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("condition did not complete");
}
function storage() {
  const files = new Map([["a.not", new TextEncoder().encode("hello")]]);
  let failWrites = false;
  const backend: VaultBackend = {
    async *readDir(parent) {
      const prefix = parent ? `${parent}/` : "";
      const children = new Set<string>();
      for (const path of files.keys()) {
        if (!path.startsWith(prefix)) continue;
        const relative = path.slice(prefix.length);
        const name = relative.split("/")[0];
        if (children.has(name)) continue;
        children.add(name);
        yield {
          path: vaultPath(prefix + name),
          kind: relative.includes("/")
            ? ("directory" as const)
            : ("file" as const),
        };
      }
    },
    async stat(path) {
      return path === ""
        ? { path, kind: "directory" }
        : [...files.keys()].some((file) => file.startsWith(`${path}/`))
          ? { path, kind: "directory" }
          : files.has(path)
            ? { path, kind: "file", size: files.get(path)!.length }
            : null;
    },
    async readFile(path) {
      return files.get(path)!.slice();
    },
    async readFileSnapshot(path) {
      const data = files.get(path)!.slice();
      return { data, revision: Array.from(data).join(",") };
    },
    async writeFile(path, data) {
      if (failWrites)
        throw new VaultError("IO", "disk write failed", path, undefined, true);
      files.set(path, data.slice());
      return Array.from(data).join(",");
    },
    async mkdir() {},
    async rename() {},
    async remove() {},
    async watch() {
      return () => {};
    },
    async close() {},
  };
  return {
    backend,
    files,
    failWrites: (fail: boolean) => {
      failWrites = fail;
    },
  };
}

/** The mock boundary serializes every request and reply, just like Tauri IPC. */
async function nativeHarness() {
  await coreReady;
  const identity = { ...baseIdentity, instanceId: crypto.randomUUID() };
  const recovery = new MemoryRecoveryFiles();
  const { backend, files, failWrites } = storage();
  const handle = crypto.randomUUID();
  let core: EditorBinding;
  let preview: PreviewBinding;
  let closes = 0;
  let failClose = false;
  const owner = new TaskQueue();
  const commands: string[] = [];
  const coreCalls: { method: string; params: Record<string, unknown> }[] = [];
  const invoke: DesktopInvoke = async <T>(command: string, args = {}) => {
    commands.push(command);
    const p = JSON.parse(JSON.stringify(args));
    let value: unknown;
    switch (command) {
      case "desktop_open":
        core =
          p.source.kind === "remote"
            ? await EditorBinding.memory(JSON.stringify(p.source.identity))
            : await EditorBinding.open(
                JSON.stringify(identity),
                createBrowserIo(backend),
                createBrowserIo(recovery),
                true,
              );
        preview = new PreviewBinding();
        value = {
          handle,
          identity: p.source.kind === "remote" ? p.source.identity : identity,
          root: p.source.kind === "remote" ? null : "/workspace",
        };
        break;
      case "desktop_core":
        coreCalls.push({ method: p.method, params: p.params });
        value = await owner.run(async () =>
          JSON.parse(await core.call(p.method, JSON.stringify(p.params))),
        );
        break;
      case "desktop_preview": {
        const x = p.params;
        switch (p.method) {
          case "synchronize":
            value = preview.synchronize(x.source);
            break;
          case "subscribe":
            value = preview.subscribe(x.id, x.sessionId);
            break;
          case "unsubscribe":
            value = preview.unsubscribe(x.subscriptionId, x.sessionId);
            break;
          case "required_snapshots":
            value = preview.required_snapshots(x.id);
            break;
          case "take_task":
            value = preview.take_task(x.id, x.source);
            break;
          case "complete":
            value = preview.complete(x.completion);
            break;
          case "retry":
            value = preview.retry(x.id);
            break;
          case "state":
            value = preview.state(x.id);
            break;
          case "events":
            value = preview.events();
            break;
          case "invalidate_project":
            preview.invalidate_project();
            break;
          case "clear":
            preview.clear();
            break;
          default:
            throw new Error(`unexpected preview method ${p.method}`);
        }
        break;
      }
      case "desktop_preview_requests":
        value = preview_resource_requests(p.task);
        break;
      case "desktop_preview_render":
        value = render_preview(p.task);
        break;
      case "desktop_changes":
        value = false;
        break;
      case "desktop_package_read":
        value = { kind: null, data: null, error: null };
        break;
      case "desktop_close":
        await owner.run(async () => {
          if (failClose) {
            failClose = false;
            throw new Error("native close failed");
          }
          core.free();
          preview.free();
          closes++;
        });
        break;
      default:
        throw new Error(`unexpected command ${command}`);
    }
    return (
      value === undefined ? undefined : JSON.parse(JSON.stringify(value))
    ) as T;
  };
  return {
    invoke,
    commands,
    coreCalls,
    files,
    failWrites,
    failNextClose: () => {
      failClose = true;
    },
    shutdown: () =>
      owner.run(async () => {
        core.free();
        preview.free();
        closes++;
      }),
    closes: () => closes,
  };
}

test("native IPC carries the shared edit, undo, preview, save and reopen lifecycle", async () => {
  const native = await nativeHarness();
  const editor = await openNativeEditor({ kind: "default" }, native.invoke);
  const documents = editor.documents;
  let unsubscribe = () => {};
  try {
    assert.equal(await documents.open(vaultPath("a.not")), true);
    const id = documents.snapshot().activeId!;
    assert.equal(replaceText(documents, id, "native edit"), true);
    await settle();
    assert.equal(
      await documents.undo(id, {
        ranges: [{ anchor: 0, head: 0 }],
        mainIndex: 0,
      }),
      true,
    );
    assert.equal(documents.snapshot().documents[0].content, "hello");
    let state: PreviewState | null = null;
    unsubscribe = documents.previews.subscribe(id, (next) => {
      state = next;
    });
    await until(() => state?.status === "ready" || state?.status === "failed");
    assert.equal(
      (state as PreviewState | null)?.status,
      "ready",
      JSON.stringify(state),
    );
    assert.ok(
      (state as PreviewState | null)?.result?.output.html.includes("hello"),
    );
    assert.equal(replaceText(documents, id, "saved native"), true);
    assert.equal(await documents.saveAll(), true);
    assert.equal(
      new TextDecoder().decode(native.files.get("a.not")),
      "saved native",
    );
  } finally {
    unsubscribe();
    await documents.close();
  }
  assert.equal(native.closes(), 1);
  assert.ok(native.commands.includes("desktop_preview_render"));
  const reopened = await openNativeEditor({ kind: "default" }, native.invoke);
  try {
    assert.equal(await reopened.documents.open(vaultPath("a.not")), true);
    assert.equal(
      reopened.documents.snapshot().documents[0].content,
      "saved native",
    );
  } finally {
    await reopened.documents.close();
  }
});

test("desktop focus reconciles missed changes in open documents, expanded folders and previews", async () => {
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const windowEvents = new EventTarget();
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: windowEvents,
  });
  const native = await nativeHarness();
  native.files.set("expanded/old.not", new TextEncoder().encode("old"));
  native.files.set("collapsed/old.not", new TextEncoder().encode("old"));
  const editor = await openNativeEditor({ kind: "default" }, native.invoke);
  const documents = editor.documents;
  const tree = new FileTreeModel(editor.backend);
  const unwatch = await editor.backend.watch(() => tree.invalidate());
  let unsubscribe = () => {};
  let closed = false;
  try {
    await documents.open(vaultPath("a.not"));
    const id = documents.snapshot().activeId!;
    let state: PreviewState | null = null;
    unsubscribe = documents.previews.subscribe(id, (next) => {
      state = next;
    });
    await until(() => state?.status === "ready");
    assert.equal(await tree.refresh(), true);
    assert.equal(await tree.toggle(vaultPath("expanded")), true);
    await settle();
    native.coreCalls.length = 0;

    // No watcher hint is emitted, as can happen before asynchronous registration.
    native.files.set("a.not", new TextEncoder().encode("missed native update"));
    native.files.set("expanded/new.not", new TextEncoder().encode("new"));
    native.files.set("collapsed/new.not", new TextEncoder().encode("new"));
    windowEvents.dispatchEvent(new Event("focus"));
    await until(
      () =>
        documents.snapshot().documents[0].content === "missed native update" &&
        tree.snapshot().byPath.has(vaultPath("expanded/new.not")) &&
        !!state?.result?.output.html.includes("missed native update"),
    );
    assert.ok(native.commands.includes("desktop_changes"));
    assert.equal(
      tree.snapshot().byPath.has(vaultPath("collapsed/new.not")),
      false,
    );
    const directories = native.coreCalls
      .filter(
        (call) => call.method === "file" && call.params.method === "readDir",
      )
      .map((call) => call.params.path);
    assert.ok(directories.includes(""));
    assert.ok(directories.includes("expanded"));
    assert.ok(!directories.includes("collapsed"));

    unsubscribe();
    await documents.close();
    closed = true;
    const callsAfterClose = native.commands.length;
    windowEvents.dispatchEvent(new Event("focus"));
    await settle();
    assert.equal(native.commands.length, callsAfterClose);
  } finally {
    unsubscribe();
    unwatch();
    tree.dispose();
    if (!closed) await documents.close();
    if (oldWindow) Object.defineProperty(globalThis, "window", oldWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

test("native directory connections deduplicate and survive manager restart", async () => {
  const native = await nativeHarness();
  let text: string | null = null;
  const file: SettingsFile = {
    async read() {
      return text;
    },
    async write(doc) {
      text = JSON.stringify(doc);
    },
  };
  let opens = 0;
  const options = {
    file,
    native: {
      async openEditor(source: Parameters<typeof openNativeEditor>[0]) {
        opens++;
        return openNativeEditor(source, native.invoke);
      },
      async pickDirectory() {
        return "/workspace";
      },
    },
  };
  // This harness has one live owner. Use unique harnesses for each manager connection.
  options.native.openEditor = async (source) => {
    opens++;
    return openNativeEditor(source, (await nativeHarness()).invoke);
  };
  const manager = new VaultManager(options);
  await manager.initialize();
  try {
    assert.equal(manager.defaultId, "native:default");
    assert.equal(manager.snapshot().connections[0].kind, "native");
    await assert.rejects(
      manager.removeConnection(manager.defaultId),
      /不可移除/,
    );
    assert.equal(await manager.openDirectory(), true);
    assert.equal(await manager.openDirectory(), true);
    assert.equal(opens, 2);
    assert.equal(
      manager
        .snapshot()
        .connections.filter((entry) => entry.kind === "directory").length,
      1,
    );
    assert.equal(await manager.prepareClose(), true);
  } finally {
    await manager.close();
  }
  const restored = new VaultManager(options);
  await restored.initialize();
  try {
    const directory = restored
      .snapshot()
      .connections.find((entry) => entry.kind === "directory")!;
    assert.equal(directory.directoryPath, "/workspace");
    assert.equal(await restored.activate(directory.id), true);
  } finally {
    await restored.close();
  }
});

test("native package resources preserve drive and UNC roots without accepting absolute Vault paths", async () => {
  const paths = [
    "/workspace/pkg",
    "C:/workspace/pkg",
    "C:\\workspace\\pkg",
    "//server/share/pkg",
    "\\\\server\\share\\pkg",
  ];
  for (const path of paths) assert.equal(absoluteResourcePath(path), true);
  assert.equal(absoluteResourcePath("components/a.js"), false);
  assert.equal(
    previewModulePath("C:/workspace/components/a.js"),
    "packages/C:/workspace/components/a.js",
  );
  let requested = "";
  const resources = new PreviewResources({} as VaultBackend, {
    root: "C:/workspace",
    async read(request) {
      requested = request.path;
      return { kind: "file", data: [65], error: null };
    },
    async readDir() {
      return [];
    },
  });
  assert.deepEqual(
    await resources.read({ path: "C:/workspace/a.not", read: true }, {
      documentPath: "a.not",
      source: "",
      overlays: {},
    } satisfies ResourceContext),
    { kind: "file", data: [65], error: null },
  );
  assert.equal(requested, "C:/workspace/a.not");
  await settle();
});

test("failed native saves keep the desktop owner and draft available until retry", async () => {
  const native = await nativeHarness();
  const manager = new VaultManager({
    file: {
      async read() {
        return null;
      },
      async write() {},
    },
    native: {
      openEditor: (source) => openNativeEditor(source, native.invoke),
      async pickDirectory() {
        return null;
      },
    },
  });
  await manager.initialize();
  try {
    const documents = manager.snapshot().active!.documents;
    await documents.open(vaultPath("a.not"));
    replaceText(
      documents,
      documents.snapshot().activeId!,
      "retained desktop draft",
    );
    native.failWrites(true);
    assert.equal(await manager.prepareClose(), false);
    assert.equal(native.closes(), 0);
    assert.equal(
      documents.snapshot().documents[0].content,
      "retained desktop draft",
    );
    assert.match(manager.snapshot().error!, /窗口仍保留/);
    native.failWrites(false);
    assert.equal(await manager.prepareClose(), true);
  } finally {
    native.failWrites(false);
    await manager.close();
  }
  assert.equal(native.closes(), 1);
});

test("desktop app documents and downloads invoke native storage without browser IO", async () => {
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const calls: { command: string; args: Record<string, unknown> }[] = [];
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      __TAURI_INTERNALS__: {
        async invoke(command: string, args: Record<string, unknown>) {
          calls.push({ command, args });
          if (command === "desktop_app_read") return "{}";
          return null;
        },
      },
    },
  });
  try {
    const file = await openAppDocument("settings.json");
    assert.equal(await file.read(), "{}");
    await file.write({ theme: "dark" });
    await downloadBytes("draft.json", new Uint8Array([65, 66]));
    assert.deepEqual(
      calls.map(({ command }) => command),
      ["desktop_app_read", "desktop_app_write", "desktop_export"],
    );
    assert.equal(calls[1].args.name, "settings.json");
    assert.equal(typeof calls[1].args.document, "object");
    assert.deepEqual(calls[1].args.document, { theme: "dark" });
    assert.deepEqual(calls[2].args, { name: "draft.json", data: [65, 66] });
  } finally {
    if (oldWindow) Object.defineProperty(globalThis, "window", oldWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

test("a failed native shutdown retains both prepared owners and resumes both view controllers", async () => {
  const first = await nativeHarness();
  const second = await nativeHarness();
  const manager = new VaultManager({
    file: {
      async read() {
        return null;
      },
      async write() {},
    },
    native: {
      openEditor: (source) =>
        openNativeEditor(
          source,
          source.kind === "default" ? first.invoke : second.invoke,
        ),
      async pickDirectory() {
        return "/second";
      },
    },
  });
  await manager.initialize();
  const local = manager.snapshot().active!.documents;
  await local.open(vaultPath("a.not"));
  await manager.openDirectory();
  const directory = manager.snapshot().active!.documents;
  await directory.open(vaultPath("a.not"));
  try {
    replaceText(local, local.snapshot().activeId!, "first draft");
    replaceText(directory, directory.snapshot().activeId!, "second draft");
    await assert.rejects(
      shutdownDesktopWorkspace(manager, async () => {
        throw new Error("native shutdown failed");
      }),
      /native shutdown failed/,
    );
    assert.equal(first.closes(), 0);
    assert.equal(second.closes(), 0);
    assert.equal(
      replaceText(local, local.snapshot().activeId!, "first remains editable"),
      true,
    );
    assert.equal(
      replaceText(
        directory,
        directory.snapshot().activeId!,
        "second remains editable",
      ),
      true,
    );
    assert.equal(
      local.snapshot().documents[0].content,
      "first remains editable",
    );
    assert.equal(
      directory.snapshot().documents[0].content,
      "second remains editable",
    );
  } finally {
    await manager.close();
  }
});

test("successful native shutdown detaches UI without calling an already released owner", async () => {
  const native = await nativeHarness();
  const manager = new VaultManager({
    file: {
      async read() {
        return null;
      },
      async write() {},
    },
    native: {
      openEditor: (source) => openNativeEditor(source, native.invoke),
      async pickDirectory() {
        return null;
      },
    },
  });
  await manager.initialize();
  await manager.snapshot().active!.documents.open(vaultPath("a.not"));
  let shutdownIndex = -1;
  assert.equal(
    await shutdownDesktopWorkspace(manager, async () => {
      shutdownIndex = native.commands.length;
      await native.shutdown();
    }),
    true,
  );
  await settle();
  assert.deepEqual(native.commands.slice(shutdownIndex), []);
  assert.equal(native.closes(), 1);
  await manager.close();
});

test("native component module URLs preserve hierarchy for relative ESM and WASM resources", () => {
  for (const prefix of [
    "celestite-preview://localhost/",
    "http://celestite-preview.localhost/",
  ]) {
    const convert = (path: string, _protocol = "asset") =>
      prefix + encodeURIComponent(path);
    const url = nativeComponentUrl(
      "scope",
      "digest",
      "C:/workspace/my package/components/card.js",
      convert,
    );
    const folder = `${prefix}scope/digest/packages/C%3A/workspace/my%20package/components/`;
    assert.equal(url, `${folder}card.js`);
    assert.equal(new URL("./dep.js", url).href, `${folder}dep.js`);
    assert.equal(new URL("./a.wasm", url).href, `${folder}a.wasm`);
  }
});

test("a failed native connection close retains input and preview until close is retried", async () => {
  const native = await nativeHarness();
  const editor = await openNativeEditor({ kind: "default" }, native.invoke);
  const documents = editor.documents;
  await documents.open(vaultPath("a.not"));
  const id = documents.snapshot().activeId!;
  let state: PreviewState | null = null;
  const unsubscribe = documents.previews.subscribe(id, (next) => {
    state = next;
  });
  try {
    await until(() => state?.status === "ready");
    native.failNextClose();
    await assert.rejects(documents.close(), /native close failed/);
    assert.equal(native.closes(), 0);
    assert.equal(
      replaceText(documents, id, "preview after failed close"),
      true,
    );
    assert.equal(await documents.saveAll(), true);
    await until(
      () =>
        state?.status === "ready" &&
        !!state.result?.output.html.includes("preview after failed close"),
    );
    assert.equal(
      documents.snapshot().documents[0].content,
      "preview after failed close",
    );
  } finally {
    unsubscribe();
    await documents.close();
  }
  assert.equal(native.closes(), 1);
});

test("a failed native remote handshake closes the manager HTTP backend", async () => {
  const originalFetch = globalThis.fetch;
  let closed = 0;
  globalThis.fetch = (() =>
    Promise.reject(new Error("handshake unavailable"))) as typeof fetch;
  try {
    await assert.rejects(
      openNativeRemoteEditor(
        "http://localhost/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        {
          async close() {
            closed++;
          },
        } as VaultBackend,
        async () => {
          assert.fail("native owner must not open before the handshake");
        },
      ),
      (error: unknown) => error instanceof VaultError && error.code === "IO",
    );
    assert.equal(closed, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("native remote close preserves both HTTP owners on failure and cleans each once after retry and detach", async () => {
  const originalFetch = globalThis.fetch;
  const originalSocket = Object.getOwnPropertyDescriptor(
    globalThis,
    "WebSocket",
  );
  const originalClose = HttpVaultBackend.prototype.close;
  let remoteCloses = 0;
  let managerCloses = 0;
  let socketCloses = 0;
  class Socket {
    static OPEN = 1;
    readyState = 1;
    onopen?: () => void;
    onmessage?: (event: { data: string }) => void;
    constructor() {
      queueMicrotask(() => this.onopen?.());
    }
    send(raw: string) {
      const request = JSON.parse(raw);
      queueMicrotask(() => {
        if (request.protocolVersion) {
          this.onmessage?.({
            data: JSON.stringify({
              kind: "hello",
              sessionId: "remote-session",
            }),
          });
          this.onmessage?.({
            data: JSON.stringify({
              kind: "ready",
              sessionId: "remote-session",
            }),
          });
        } else {
          this.onmessage?.({
            data: JSON.stringify({
              kind: "reply",
              requestId: request.requestId,
              result: null,
            }),
          });
        }
      });
    }
    close() {
      socketCloses++;
    }
  }
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    value: Socket,
  });
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    return Response.json(
      url.pathname.endsWith("/stat")
        ? { path: url.searchParams.get("path"), kind: "file", size: 5 }
        : {
            protocol: "celestite-vault",
            protocolVersion: 5,
            shareId: "remote",
            name: "Remote",
            readOnly: false,
            vault: baseIdentity.vault,
            capabilities: {
              watch: false,
              conditionalWrite: true,
              websocketSync: true,
            },
          },
    );
  }) as typeof fetch;
  HttpVaultBackend.prototype.close = async function () {
    remoteCloses++;
    await originalClose.call(this);
  };
  const managerBackend = storage().backend;
  managerBackend.close = async () => {
    managerCloses++;
  };
  const native = await nativeHarness();
  let documents:
    Awaited<ReturnType<typeof openNativeRemoteEditor>>["documents"] | undefined;
  try {
    const editor = await openNativeRemoteEditor(
      "http://localhost/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      managerBackend,
      native.invoke,
    );
    documents = editor.documents;
    native.failNextClose();
    await assert.rejects(documents.close(), /native close failed/);
    assert.equal(native.closes(), 0);
    assert.equal(remoteCloses, 0);
    assert.equal(managerCloses, 0);
    assert.equal(socketCloses, 0);
    assert.equal((await editor.backend.stat(vaultPath("a.not")))?.kind, "file");
    await documents.close();
    documents.detach();
    documents.detach();
    await settle();
    assert.equal(native.closes(), 1);
    assert.equal(remoteCloses, 1);
    assert.equal(managerCloses, 1);
    assert.equal(socketCloses, 1);
  } finally {
    await documents?.close();
    HttpVaultBackend.prototype.close = originalClose;
    globalThis.fetch = originalFetch;
    if (originalSocket)
      Object.defineProperty(globalThis, "WebSocket", originalSocket);
    else Reflect.deleteProperty(globalThis, "WebSocket");
  }
});

test("an aborted native executor never reads resources or renders after an in-flight analysis", async () => {
  let release!: (value: unknown) => void;
  const pending = new Promise<unknown>((resolve) => {
    release = resolve;
  });
  const commands: string[] = [];
  const executor = nativePreviewExecutor(
    "session",
    async <T>(command: string) => {
      commands.push(command);
      return (await pending) as T;
    },
  );
  const abort = new AbortController();
  const result = executor.execute(
    {
      ticket: { taskId: "cancelled" },
      source: "hello",
    } as PreviewTask,
    async () => {
      assert.fail("aborted analysis must not start resource IO");
    },
    abort.signal,
  );
  await until(() => commands.length === 1);
  abort.abort();
  await assert.rejects(result, { name: "AbortError" });
  release([{ path: "a.not", read: true }]);
  await settle();
  assert.deepEqual(commands, ["desktop_preview_requests"]);
});

test("desktop shutdown retries known connection changes after a temporary storage failure", async () => {
  let failed = true;
  let stored: Record<string, unknown> | undefined;
  let writes = 0;
  const manager = new VaultManager({
    file: {
      async read() {
        return null;
      },
      async write(document) {
        writes++;
        if (failed) throw new Error("connections unavailable");
        stored = document;
      },
    },
    native: {
      async openEditor(source) {
        return openNativeEditor(source, (await nativeHarness()).invoke);
      },
      async pickDirectory() {
        return "/directory";
      },
    },
  });
  await manager.initialize();
  try {
    await manager.openDirectory();
    assert.match(manager.snapshot().persistenceError!, /未保存/);
    const failedPreparation = manager.prepareClose();
    assert.equal(await failedPreparation, false);
    assert.equal(await manager.activate(manager.defaultId), true);
    failed = false;
    const retriedPreparation = manager.prepareClose();
    assert.notEqual(retriedPreparation, failedPreparation);
    assert.equal(await retriedPreparation, true);
    assert.equal(manager.snapshot().persistenceError, null);
    assert.ok(writes >= 3);
    assert.equal((stored!.connections as unknown[]).length, 1);
  } finally {
    await manager.close();
  }
});

test("desktop shutdown never overwrites connection records it could not read", async () => {
  const manager = new VaultManager({
    file: {
      async read() {
        throw new Error("connections temporarily unreadable");
      },
      async write() {
        assert.fail("unread connection records must be retained");
      },
    },
    native: {
      async openEditor(source) {
        return openNativeEditor(source, (await nativeHarness()).invoke);
      },
      async pickDirectory() {
        return null;
      },
    },
  });
  await manager.initialize();
  try {
    assert.match(manager.snapshot().persistenceError!, /无法读取/);
    assert.equal(await manager.prepareClose(), true);
  } finally {
    await manager.close();
  }
});

test("new desktop connections merge a recovered app document before any write", async () => {
  let unreadable = true;
  let writes = 0;
  const oldId = `remote:${crypto.randomUUID()}`;
  let stored = JSON.stringify({
    version: 2,
    connections: [
      {
        id: oldId,
        name: "Existing server",
        url: "https://example.com/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      },
    ],
  });
  const manager = new VaultManager({
    file: {
      async read() {
        if (unreadable) throw new Error("app file busy");
        return stored;
      },
      async write(document) {
        assert.equal(unreadable, false);
        writes++;
        stored = JSON.stringify(document);
      },
    },
    native: {
      async openEditor(source) {
        return openNativeEditor(source, (await nativeHarness()).invoke);
      },
      async pickDirectory() {
        return "/new-directory";
      },
    },
  });
  await manager.initialize();
  try {
    await manager.openDirectory();
    assert.equal(writes, 0);
    unreadable = false;
    assert.equal(await manager.prepareClose(), true);
    const recovered = JSON.parse(stored).connections;
    assert.equal(recovered.length, 2);
    assert.ok(
      recovered.some((connection: { id: string }) => connection.id === oldId),
    );
  } finally {
    await manager.close();
  }
});

test("native external links use HTTPS for protocol-relative URLs and retain explicit protocols", () => {
  assert.equal(
    nativeExternalUrl("//example.com/docs?q=1#section"),
    "https://example.com/docs?q=1#section",
  );
  assert.equal(
    nativeExternalUrl("ftp://example.com/file.txt"),
    "ftp://example.com/file.txt",
  );
  assert.equal(
    nativeExternalUrl("mailto:notes@example.com"),
    "mailto:notes@example.com",
  );
});

test("desktop preparation from a synchronous subscriber freezes new actions and drains the accepted picker and editor", async () => {
  const local = await nativeHarness();
  const directory = await nativeHarness();
  let releasePicker!: (path: string) => void;
  let releaseEditor!: () => void;
  const picked = new Promise<string>((resolve) => {
    releasePicker = resolve;
  });
  const editorGate = new Promise<void>((resolve) => {
    releaseEditor = resolve;
  });
  let pickerCalls = 0;
  let editorStarted = false;
  const manager = new VaultManager({
    file: {
      async read() {
        return null;
      },
      async write() {},
    },
    native: {
      async pickDirectory() {
        pickerCalls++;
        return picked;
      },
      async openEditor(source) {
        if (source.kind === "default")
          return openNativeEditor(source, local.invoke);
        editorStarted = true;
        await editorGate;
        return openNativeEditor(source, directory.invoke);
      },
    },
  });
  await manager.initialize();
  let requested = false;
  let fromSubscriber: Promise<boolean> | undefined;
  const unsubscribe = manager.subscribe((state) => {
    if (state.opening && !requested) {
      requested = true;
      fromSubscriber = manager.prepareClose();
    }
  });
  try {
    const opening = manager.openDirectory();
    const preparation = fromSubscriber!;
    assert.ok(preparation);
    assert.equal(manager.prepareClose(), preparation);
    assert.equal(manager.snapshot().opening, true);
    let prepared = false;
    void preparation.then(() => {
      prepared = true;
    });
    await assert.rejects(
      manager.openDirectory(),
      (error: unknown) => error instanceof VaultError && error.code === "Busy",
    );
    await assert.rejects(
      manager.connect(
        "https://example.com/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      ),
      (error: unknown) => error instanceof VaultError && error.code === "Busy",
    );
    await assert.rejects(
      manager.removeConnection(manager.defaultId),
      (error: unknown) => error instanceof VaultError && error.code === "Busy",
    );
    assert.equal(await manager.activate(manager.defaultId), false);
    assert.equal(pickerCalls, 1);
    assert.equal(prepared, false);
    releasePicker("/delayed-directory");
    await until(() => editorStarted);
    assert.equal(prepared, false);
    releaseEditor();
    assert.equal(await opening, true);
    assert.equal(await preparation, true);
    assert.equal(manager.snapshot().opened.length, 2);
    assert.equal(
      await manager.snapshot().active!.documents.open(vaultPath("a.not")),
      false,
    );
    await assert.rejects(
      manager.openDirectory(),
      (error: unknown) => error instanceof VaultError && error.code === "Busy",
    );
    assert.equal(manager.prepareClose(), preparation);
    manager.resumeAfterCloseFailure();
    assert.equal(manager.snapshot().opening, false);
    assert.equal(
      await manager.snapshot().active!.documents.open(vaultPath("a.not")),
      true,
    );
    assert.equal(await manager.openDirectory(), true);
    const retried = manager.prepareClose();
    assert.notEqual(retried, preparation);
    assert.equal(await retried, true);
  } finally {
    unsubscribe();
    releasePicker("/delayed-directory");
    releaseEditor();
    await manager.close();
  }
});

test("desktop preparation drains an accepted removal before selecting the remaining owners", async () => {
  const manager = new VaultManager({
    file: {
      async read() {
        return null;
      },
      async write() {},
    },
    native: {
      async openEditor(source) {
        return openNativeEditor(source, (await nativeHarness()).invoke);
      },
      async pickDirectory() {
        return "/removing";
      },
    },
  });
  await manager.initialize();
  await manager.openDirectory();
  const vault = manager.snapshot().active!;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let removing = false;
  const close = vault.documents.close.bind(vault.documents);
  vault.documents.close = async () => {
    removing = true;
    await gate;
    await close();
  };
  try {
    const removal = manager.removeConnection(vault.id);
    const preparation = manager.prepareClose();
    let prepared = false;
    void preparation.then(() => {
      prepared = true;
    });
    await until(() => removing);
    assert.equal(prepared, false);
    release();
    await removal;
    assert.equal(await preparation, true);
    assert.equal(manager.snapshot().opened.length, 1);
    assert.equal(manager.snapshot().active!.id, manager.defaultId);
  } finally {
    release();
    await manager.close();
  }
});

test("desktop preparation drains accepted initialization and its internal default activation", async () => {
  let finishRead!: (value: null) => void;
  const reading = new Promise<null>((resolve) => {
    finishRead = resolve;
  });
  const manager = new VaultManager({
    file: { read: () => reading, async write() {} },
    native: {
      async openEditor(source) {
        return openNativeEditor(source, (await nativeHarness()).invoke);
      },
      async pickDirectory() {
        return null;
      },
    },
  });
  const initialized = manager.initialize();
  const preparation = manager.prepareClose();
  try {
    assert.equal(manager.snapshot().active, null);
    finishRead(null);
    await initialized;
    assert.equal(await preparation, true);
    assert.equal(manager.snapshot().active!.id, manager.defaultId);
    assert.equal(manager.snapshot().opened.length, 1);
  } finally {
    finishRead(null);
    await manager.close();
  }
});

test("native language worker maps worker traffic to desktop_language invokes", async () => {
  const calls: { command: string; args: unknown }[] = [];
  const invoke: DesktopInvoke = async <T>(command: string, args = {}) => {
    calls.push({ command, args });
    const request = (args as { command: { kind: string } }).command;
    if (command === "desktop_language")
      return (
        request.kind === "invalidate" || request.kind === "reset"
          ? []
          : ['{"jsonrpc":"2.0","id":1,"result":null}']
      ) as T;
    throw new Error(`unexpected ${command}`);
  };
  const worker = nativeLanguageWorker("handle-1", invoke);
  const replies: LanguageWorkerReply[] = [];
  worker.addEventListener("message", (event) => replies.push(event.data));
  worker.postMessage({
    kind: "message",
    id: 3,
    root: "/vault",
    message: '{"jsonrpc":"2.0"}',
  });
  await settle();
  assert.deepEqual(calls, [
    {
      command: "desktop_language",
      args: { handle: "handle-1", command: { kind: "reset" } },
    },
    {
      command: "desktop_language",
      args: {
        handle: "handle-1",
        command: { kind: "message", message: '{"jsonrpc":"2.0"}' },
      },
    },
  ]);
  assert.deepEqual(replies, [
    {
      kind: "messages",
      id: 3,
      messages: ['{"jsonrpc":"2.0","id":1,"result":null}'],
    },
    { kind: "done", id: 3 },
  ]);
  worker.postMessage({ kind: "invalidate", id: 4, root: "/vault" });
  await settle();
  assert.deepEqual(calls[2].args, {
    handle: "handle-1",
    command: { kind: "invalidate" },
  });
  assert.deepEqual(replies[2], { kind: "done", id: 4 });
  // Resource replies never cross the invoke boundary; failures settle items.
  worker.postMessage({ kind: "resources", id: 5, resources: {} });
  await settle();
  assert.equal(calls.length, 3);
  const failing = nativeLanguageWorker("handle-2", async () => {
    throw new Error("closed");
  });
  const failures: LanguageWorkerReply[] = [];
  failing.addEventListener("message", (event) => failures.push(event.data));
  failing.postMessage({
    kind: "message",
    id: 6,
    root: "/vault",
    message: "{}",
  });
  await settle();
  assert.deepEqual(failures, [{ kind: "error", id: 6, message: "closed" }]);
});
