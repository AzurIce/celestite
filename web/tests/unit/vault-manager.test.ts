import { test } from "node:test";
import assert from "node:assert/strict";
import { VaultManager, DEFAULT_VAULT_ID } from "../../src/lib/vault/manager";
import { vaultPath, ROOT_PATH, VaultError } from "../../src/lib/vault";
import type { VaultBackend, VaultPath } from "../../src/lib/vault";
import type { SettingsFile } from "../../src/lib/settings/app-file";
import type { HttpVaultBackend } from "../../src/lib/vault/http";
import { VaultDocuments } from "../../src/lib/editor/documents";
import type { openRemoteEditor } from "../../src/lib/editor/client/documents";
const fakeRemoteEditor: typeof openRemoteEditor = async (_url, backend) => {
  const documents = new VaultDocuments(backend);
  return {
    identity: {
      instanceId: "test",
      vault: { vaultId: "test", historyId: "test" },
    },
    documents,
    backend: documents.treeBackend,
  };
};
function files() {
  const contents = new Map<VaultPath, Uint8Array>([
    [vaultPath("a.md"), new TextEncoder().encode("old")],
  ]);
  let failure = false,
    closed = false,
    removed = 0;
  const backend: VaultBackend = {
    async *readDir(parent) {
      if (parent === ROOT_PATH)
        for (const path of contents.keys()) yield { path, kind: "file" };
    },
    async stat(path) {
      if (path === ROOT_PATH) return { path, kind: "directory" };
      const data = contents.get(path);
      return data ? { path, kind: "file", size: data.length } : null;
    },
    async readFile(path) {
      return contents.get(path)!.slice();
    },
    async writeFile(path, data) {
      if (failure) throw new VaultError("IO", "save failed");
      contents.set(path, data.slice());
    },
    async mkdir() {},
    async rename() {},
    async remove() {
      removed++;
    },
    async watch() {
      return () => {};
    },
    async close() {
      closed = true;
    },
  };
  return {
    backend,
    contents,
    setFailure: () => {
      failure = true;
    },
    isClosed: () => closed,
    removed: () => removed,
  };
}
class Registry implements SettingsFile {
  text: string | null = null;
  async read() {
    return this.text;
  }
  async write(document: Record<string, unknown>) {
    this.text = JSON.stringify(document);
  }
}
const url = "https://example.com/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
function setup(registry = new Registry()) {
  const local = files(),
    remote = files();
  let calls = 0;
  const manager = new VaultManager({
    file: registry,
    openLocal: async () => local.backend,
    openRemoteEditor: fakeRemoteEditor,
    openRemote: async () => {
      calls++;
      return {
        backend: remote.backend as HttpVaultBackend,
        descriptor: {
          protocol: "celestite-vault",
          version: 1,
          shareId: "test-share",
          vaultIdentity: { id: "test-vault", historyId: "test-history" },
          name: "Remote",
          readOnly: false,
          capabilities: { watch: true, conditionalWrite: true },
        },
      };
    },
  });
  return { manager, local, remote, registry, calls: () => calls };
}
test("simultaneous connections to the same share reuse one instance", async () => {
  const { manager, calls } = setup();
  await manager.initialize();
  assert.deepEqual(
    await Promise.all([manager.connect(url), manager.connect(url + "/")]),
    [true, true],
  );
  assert.equal(calls(), 1);
  assert.equal(manager.snapshot().connections.length, 2);
  assert.equal(manager.snapshot().opened.length, 2);
  await manager.close();
});
test("the default Vault cannot be removed and opening identities isolate buffers and tree state", async () => {
  const { manager } = setup();
  await manager.initialize();
  const local = manager.snapshot().active!;
  await assert.rejects(manager.removeConnection(DEFAULT_VAULT_ID), {
    code: "PermissionDenied",
  });
  await local.documents.open(vaultPath("a.md"));
  const localId = local.documents.snapshot().activeId!;
  local.documents.update(localId, "local edit");
  await local.tree.refresh();
  local.tree.select(vaultPath("a.md"));
  await manager.connect(url);
  const remote = manager.snapshot().active!;
  assert.notEqual(remote, local);
  assert.notEqual(remote.documents, local.documents);
  await remote.documents.open(vaultPath("a.md"));
  assert.equal(remote.documents.snapshot().documents[0].content, "old");
  await manager.activate(DEFAULT_VAULT_ID);
  assert.equal(manager.snapshot().active, local);
  assert.equal(local.documents.snapshot().documents[0].content, "local edit");
  assert.equal(local.tree.snapshot().selected.has(vaultPath("a.md")), true);
  await manager.close();
});
test("connections restore lazily and removing a connection never deletes remote files", async () => {
  const registry = new Registry();
  registry.text = JSON.stringify({
    version: 2,
    connections: [
      {
        id: "remote:00000000-0000-4000-8000-000000000001",
        url,
        name: "Remote",
      },
    ],
  });
  const { manager, remote, calls } = setup(registry);
  await manager.initialize();
  await manager.initialize();
  assert.equal(manager.snapshot().connections.length, 2);
  assert.equal(calls(), 0);
  const id = manager.snapshot().connections[1].id;
  await manager.activate(id);
  assert.equal(calls(), 1);
  await manager.removeConnection(id);
  assert.equal(remote.isClosed(), true);
  assert.equal(remote.removed(), 0);
  assert.equal(manager.snapshot().connections.length, 1);
  assert.equal(manager.snapshot().active!.id, DEFAULT_VAULT_ID);
  assert.deepEqual(JSON.parse(registry.text!).connections, []);
  await manager.close();
});
test("failed saves keep the connection, backend and dirty buffer alive", async () => {
  const { manager, remote } = setup();
  await manager.initialize();
  await manager.connect(url);
  const vault = manager.snapshot().active!;
  await vault.documents.open(vaultPath("a.md"));
  vault.documents.update(vault.documents.snapshot().activeId!, "unsaved");
  remote.setFailure();
  await assert.rejects(manager.removeConnection(vault.id));
  assert.equal(manager.snapshot().active, vault);
  assert.equal(remote.isClosed(), false);
  assert.equal(vault.documents.hasUnsaved(), true);
  assert.equal(manager.snapshot().connections.length, 2);
  await manager.close();
});
test("an obsolete open cannot activate after a more recent selection", async () => {
  const registry = new Registry();
  registry.text = JSON.stringify({
    version: 2,
    connections: [
      {
        id: "remote:00000000-0000-4000-8000-000000000001",
        url,
        name: "Remote",
      },
    ],
  });
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const local = files(),
    remote = files();
  const manager = new VaultManager({
    file: registry,
    openLocal: async () => local.backend,
    openRemoteEditor: fakeRemoteEditor,
    openRemote: async () => {
      await pending;
      return {
        backend: remote.backend as HttpVaultBackend,
        descriptor: {
          protocol: "celestite-vault",
          version: 1,
          shareId: "test-share",
          vaultIdentity: { id: "test-vault", historyId: "test-history" },
          name: "Remote",
          readOnly: false,
          capabilities: { watch: true, conditionalWrite: true },
        },
      };
    },
  });
  await manager.initialize();
  const opening = manager.activate(manager.snapshot().connections[1].id);
  await manager.activate(DEFAULT_VAULT_ID);
  release();
  assert.equal(await opening, false);
  assert.equal(manager.snapshot().active!.id, DEFAULT_VAULT_ID);
  assert.equal(manager.snapshot().opened.length, 2);
  await manager.close();
});

test("readonly and edit shares of one Vault keep separate instances and non-secret connection IDs", async () => {
  const registry = new Registry();
  const local = files();
  const manager = new VaultManager({
    file: registry,
    openLocal: async () => local.backend,
    openRemoteEditor: fakeRemoteEditor,
    openRemote: async (url) => ({
      backend: files().backend as HttpVaultBackend,
      descriptor: {
        protocol: "celestite-vault",
        version: 1,
        shareId: url.includes("/ro-") ? "reader" : "editor",
        name: "Same Vault",
        readOnly: url.includes("/ro-"),
        vaultIdentity: { id: "vault", historyId: "history" },
        capabilities: { watch: true, conditionalWrite: true },
      },
    }),
  });
  await manager.initialize();
  await manager.connect(url);
  const editor = manager.snapshot().active!;
  const readonlyUrl = url.replace("/AAAA", "/ro-AAAA");
  await manager.connect(readonlyUrl);
  const reader = manager.snapshot().active!;
  assert.notEqual(editor.id, reader.id);
  assert.notEqual(editor.documents, reader.documents);
  assert.equal(editor.readOnly, false);
  assert.equal(reader.readOnly, true);
  assert.ok(!editor.id.includes(url));
  assert.equal(JSON.parse(registry.text!).connections.length, 2);
  await manager.close();
});
