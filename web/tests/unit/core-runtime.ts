import { readFile } from "node:fs/promises";
import init, {
  EditorBinding,
  PreviewBinding,
} from "../../src/lib/editor/generated/celestite_core";
import { createBrowserIo } from "../../src/lib/editor/local/io";
import { LocalEditorSession } from "../../src/lib/editor/local/session";
import {
  serveEditor,
  type EditorServicePort,
} from "../../src/lib/editor/runtime/service";
import { EditorClient, type MessageTransport } from "../../src/lib/editor/rpc";
import { ClientDocuments } from "../../src/lib/editor/client/documents";
import type {
  EditorDocuments,
  InstanceIdentity,
  ServiceMessage,
  ServiceRequest,
} from "../../src/lib/editor/contract";
import { VaultError } from "../../src/lib/vault/errors";
import type { VaultBackend, WriteFileOptions } from "../../src/lib/vault/types";
import { vaultPath, type VaultPath } from "../../src/lib/vault/path";
import { PreviewResources } from "../../src/lib/preview/resources";
import { wasmCore } from "../../src/lib/editor/core";

export const coreReady = readFile(
  new URL(
    "../../src/lib/editor/generated/celestite_core_bg.wasm",
    import.meta.url,
  ),
).then((bytes) => init({ module_or_path: bytes }));

/** Only IO is faked. All editing, history, recovery and commands run production code. */
export class MemoryRecoveryFiles implements VaultBackend {
  readonly files = new Map<string, Uint8Array>();
  readonly directories = new Set<string>([""]);
  failWrites = false;
  async *readDir(path: VaultPath) {
    if (!this.directories.has(path))
      throw new VaultError("NotFound", "missing", path);
    const parent = (name: string) =>
      name.includes("/") ? name.slice(0, name.lastIndexOf("/")) : "";
    for (const name of this.directories)
      if (name !== path && parent(name) === path)
        yield { path: vaultPath(name), kind: "directory" as const };
    for (const name of this.files.keys())
      if (parent(name) === path)
        yield { path: vaultPath(name), kind: "file" as const };
  }
  async stat(path: VaultPath) {
    if (this.directories.has(path)) return { path, kind: "directory" as const };
    const data = this.files.get(path);
    return data ? { path, kind: "file" as const, size: data.length } : null;
  }
  async readFile(path: VaultPath) {
    const data = this.files.get(path);
    if (!data) throw new VaultError("NotFound", "missing", path);
    return data.slice();
  }
  async readFileSnapshot(path: VaultPath) {
    const data = await this.readFile(path);
    return { data, revision: Array.from(data).join(",") };
  }
  async writeFile(
    path: VaultPath,
    data: Uint8Array,
    options: WriteFileOptions,
  ) {
    if (this.failWrites) throw new VaultError("IO", "recovery write failed");
    if (options.mode === "create" && this.files.has(path))
      throw new VaultError("AlreadyExists", "exists", path);
    if (options.mode === "replace" && !this.files.has(path))
      throw new VaultError("NotFound", "missing", path);
    if (
      options.expectedRevision !== undefined &&
      options.expectedRevision !== (await this.readFileSnapshot(path)).revision
    )
      throw new VaultError("Conflict", "changed", path);
    this.files.set(path, data.slice());
    return Array.from(data).join(",");
  }
  async mkdir(path: VaultPath) {
    let parent = "";
    for (const part of path.split("/")) {
      parent = parent ? `${parent}/${part}` : part;
      this.directories.add(parent);
    }
  }
  async rename(from: VaultPath, to: VaultPath) {
    if (!(await this.stat(from)))
      throw new VaultError("NotFound", "missing", from);
    if (await this.stat(to))
      throw new VaultError("AlreadyExists", "exists", to);
    for (const [name, data] of [...this.files])
      if (name === from || name.startsWith(from + "/")) {
        this.files.delete(name);
        this.files.set(to + name.slice(from.length), data);
      }
    for (const name of [...this.directories])
      if (name === from || name.startsWith(from + "/")) {
        this.directories.delete(name);
        this.directories.add(to + name.slice(from.length));
      }
  }
  async remove(path: VaultPath) {
    for (const name of [...this.files.keys()])
      if (name === path || name.startsWith(path + "/")) this.files.delete(name);
    for (const name of [...this.directories])
      if (name === path || name.startsWith(path + "/"))
        this.directories.delete(name);
  }
  async watch() {
    return () => {};
  }
  async close() {}
}

export async function createTestEditor(
  backend: VaultBackend,
  recovery = new MemoryRecoveryFiles(),
  identity: InstanceIdentity = {
    instanceId: crypto.randomUUID(),
    vault: { vaultId: crypto.randomUUID(), historyId: crypto.randomUUID() },
  },
) {
  await coreReady;
  const listeners = new Set<(event: MessageEvent<ServiceMessage>) => void>();
  let incoming!: (event: MessageEvent<ServiceRequest>) => void;
  const transport: MessageTransport = {
    postMessage: (data) =>
      queueMicrotask(() => incoming(new MessageEvent("message", { data }))),
    addEventListener: (_, listener) => {
      listeners.add(listener);
    },
    removeEventListener: (_, listener) => {
      listeners.delete(listener);
    },
  };
  const port: EditorServicePort = {
    postMessage: (data) =>
      queueMicrotask(() => {
        for (const listener of listeners)
          listener(new MessageEvent("message", { data }));
      }),
    addEventListener: (_, listener) => {
      incoming = listener;
    },
  };
  const client = new EditorClient(transport);
  const lifetime = serveEditor(port, async (emit, schedule) => {
    const core = await EditorBinding.open(
      JSON.stringify(identity),
      createBrowserIo(backend),
      createBrowserIo(recovery),
      false,
    );
    return {
      identity,
      host: new LocalEditorSession(wasmCore(core), backend, emit, schedule),
      previewBinding: new PreviewBinding(),
      previewResources: new PreviewResources(backend),
      dispose: () => core.free(),
    };
  }).catch((error) => client.fail(error));
  await client.ready;
  const documents = new ClientDocuments(client, () => {
    void lifetime;
  });
  return {
    identity,
    documents,
    backend: documents.treeBackend,
    recovery,
    lifetime,
  };
}

export function replaceText(
  documents: EditorDocuments,
  id: string,
  text: string,
): boolean {
  const before = documents
    .snapshot()
    .documents.find((document) => document.id === id)!;
  return documents.edit(id, {
    edits: [{ from: 0, to: before.content.length, insert: text }],
    content: text,
    userEvent: "input.replace",
    before: { ranges: [{ anchor: 0, head: 0 }], mainIndex: 0 },
    after: {
      ranges: [{ anchor: text.length, head: text.length }],
      mainIndex: 0,
    },
  });
}
