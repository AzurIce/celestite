import { test } from "node:test";
import assert from "node:assert/strict";
import { VaultManager, DEFAULT_VAULT_ID } from "../../src/lib/vault/manager";
import { vaultPath, ROOT_PATH, VaultError } from "../../src/lib/vault";
import type { VaultBackend, VaultPath } from "../../src/lib/vault";
import type { SettingsFile } from "../../src/lib/settings/app-file";
import type { HttpVaultBackend } from "../../src/lib/vault/http";
import { VaultDocuments } from "../../src/lib/editor/documents";
import type { openRemoteEditor } from "../../src/lib/editor/client/documents";
const fakeRemoteEditor: typeof openRemoteEditor = async (
  _url,
  _token,
  backend,
) => {
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
const url = "https://example.com/api/v1/vaults/notes";
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
          id: "notes",
          name: "Remote",
          readOnly: false,
          capabilities: { watch: true, conditionalWrite: true },
        },
      };
    },
  });
  return { manager, local, remote, registry, calls: () => calls };
}
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
    version: 1,
    connections: [{ url, name: "Remote" }],
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
    version: 1,
    connections: [{ url, name: "Remote" }],
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
          id: "notes",
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

function localDirectorySetup(registryFailure = false) {
  const local = files(),
    directory = files();
  let selected = true,
    permission: PermissionState = "granted",
    prompts = 0,
    opens = 0;
  const handle = {
    kind: "directory",
    name: "Project",
    async requestPermission() {
      prompts++;
      return permission;
    },
  } as unknown as import("../../src/lib/vault/file-system-access").LocalDirectoryHandle;
  const records = new Map<
    string,
    import("../../src/lib/vault/directory-registry").DirectoryConnection
  >();
  const directories: import("../../src/lib/vault/directory-registry").DirectoryRegistry =
    {
      async list() {
        if (registryFailure) throw new Error("IDB unavailable");
        return [...records.values()];
      },
      async remember(handle) {
        const record = { id: "directory:project", name: handle.name, handle };
        records.set(record.id, record);
        return record;
      },
      async forget(id) {
        records.delete(id);
      },
      async setResourceScope(id, scope) {
        const record = records.get(id)!;
        records.set(id, { ...record, resourceScope: scope });
      },
    };
  const create = () =>
    new VaultManager({
      file: new Registry(),
      directories,
      openLocal: async () => local.backend,
      pickDirectory: async () => (selected ? handle : null),
      openLocalEditor: async (source) => {
        assert.equal(source.kind, "directory");
        opens++;
        const documents = new VaultDocuments(directory.backend);
        return {
          identity: {
            instanceId: "dir",
            vault: { vaultId: "dir", historyId: "dir" },
          },
          backend: documents.treeBackend,
          documents,
        };
      },
    });
  return {
    create,
    directory,
    records,
    opens: () => opens,
    prompts: () => prompts,
    deny: () => {
      permission = "denied";
    },
    grant: () => {
      permission = "granted";
    },
    cancel: () => {
      selected = false;
    },
  };
}

test("directory connections reuse their runtime, restore lazily, and authorize before reopening", async () => {
  const state = localDirectorySetup();
  const first = state.create();
  await first.initialize();
  await first.openDirectory();
  const runtime = first.snapshot().active!;
  await first.openDirectory();
  assert.equal(first.snapshot().active, runtime);
  assert.equal(first.snapshot().connections.length, 2);
  assert.equal(state.opens(), 1);
  const second = state.create();
  await second.initialize();
  assert.equal(state.opens(), 1);
  assert.equal(second.snapshot().connections[1].kind, "directory");
  const opening = second.activate(runtime.id);
  assert.equal(
    state.prompts(),
    1,
    "permission is requested synchronously from the click",
  );
  assert.equal(await opening, true);
  assert.equal(state.opens(), 2);
  await first.close();
  await second.close();
});

test("denied directory permission retains the runtime and dirty edits until a new grant", async () => {
  const state = localDirectorySetup();
  const manager = state.create();
  await manager.initialize();
  await manager.openDirectory();
  const runtime = manager.snapshot().active!;
  await runtime.documents.open(vaultPath("a.md"));
  runtime.documents.update(runtime.documents.snapshot().activeId!, "unsaved");
  state.deny();
  assert.equal(await manager.activate(runtime.id), false);
  assert.match(manager.snapshot().error!, /读写权限/);
  assert.equal(runtime.documents.snapshot().documents[0].content, "unsaved");
  assert.equal(state.directory.isClosed(), false);
  state.grant();
  assert.equal(await manager.activate(runtime.id), true);
  assert.equal(state.opens(), 1);
  await manager.close();
});

test("removing a directory forgets its handle only after saving; save failure retains the connection", async () => {
  const state = localDirectorySetup();
  const manager = state.create();
  await manager.initialize();
  await manager.openDirectory();
  const runtime = manager.snapshot().active!;
  await manager.removeConnection(runtime.id);
  assert.equal(state.records.size, 0);
  assert.equal(state.directory.removed(), 0);
  assert.equal(state.directory.isClosed(), true);
  assert.equal(manager.snapshot().active!.id, DEFAULT_VAULT_ID);
  await manager.close();

  const failure = localDirectorySetup();
  const second = failure.create();
  await second.initialize();
  await second.openDirectory();
  const dirty = second.snapshot().active!;
  await dirty.documents.open(vaultPath("a.md"));
  dirty.documents.update(dirty.documents.snapshot().activeId!, "unsaved");
  failure.directory.setFailure();
  await assert.rejects(second.removeConnection(dirty.id));
  assert.equal(failure.records.size, 1);
  assert.equal(failure.directory.isClosed(), false);
  await second.close();
});

test("picker cancellation and unavailable directory storage preserve the default Vault", async () => {
  const state = localDirectorySetup(true);
  const manager = state.create();
  await manager.initialize();
  assert.equal(manager.snapshot().active!.id, DEFAULT_VAULT_ID);
  assert.match(manager.snapshot().persistenceError!, /IDB unavailable/);
  state.cancel();
  assert.equal(await manager.openDirectory(), false);
  assert.equal(manager.snapshot().connections.length, 1);
  assert.equal(manager.snapshot().opening, false);
  await manager.close();
});
