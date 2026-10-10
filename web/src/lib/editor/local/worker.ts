import init, {
  EditorBinding,
  PreviewBinding,
} from "../generated/celestite_core";
import { openOpfsVault } from "../../vault/opfs";
import {
  openDirectoryVault,
  type LocalDirectoryHandle,
} from "../../vault/file-system-access";
import { VaultError } from "../../vault/errors";
import { vaultPath } from "../../vault/path";
import { OpfsInstanceStore } from "./store";
import { createBrowserIo } from "./io";
import { EditorHost } from "../runtime/host";
import { DirectoryEditorHost } from "./host";
import { encodeError } from "../rpc";
import { serveEditor, type EditorServicePort } from "../runtime/service";
import { DirectoryPackageResources } from "./package-resources";
import { PreviewResources } from "../../preview/resources";

export type LocalEditorSource =
  | { kind: "opfs"; id: "default" }
  | {
      kind: "directory";
      id: string;
      handle: LocalDirectoryHandle;
      resourceScope?: LocalDirectoryHandle;
    };

async function start(source: LocalEditorSource) {
  const storeId =
    source.kind === "opfs"
      ? source.id
      : `directory-${source.id.slice("directory:".length)}`;
  vaultPath(storeId);
  await navigator.locks.request(
    `celestite.editor.instance:${storeId}`,
    { ifAvailable: true },
    async (lock) => {
      if (!lock)
        throw new VaultError(
          "Busy",
          "此 Vault 已在另一标签页中打开，请先关闭该标签页。",
        );
      await serveEditor(
        self as unknown as EditorServicePort,
        async (emit, schedule) => {
          await init();
          const backend =
            source.kind === "opfs"
              ? await openOpfsVault(source.id)
              : await openDirectoryVault(source.handle, source.id);
          try {
            const store = await OpfsInstanceStore.open(storeId);
            const binding = await EditorBinding.open(
              JSON.stringify(store.identity),
              createBrowserIo(store, backend),
              source.kind === "directory",
            );
            // A stale optional resource capability must not prevent opening the Vault.
            const packages =
              source.kind === "directory" && source.resourceScope
                ? await DirectoryPackageResources.open(
                    source.resourceScope,
                    source.handle,
                  ).catch(() => undefined)
                : undefined;
            const previewResources = new PreviewResources(backend, packages);
            const host =
              source.kind === "directory"
                ? new DirectoryEditorHost(binding, backend, emit, schedule)
                : new EditorHost(binding, backend, emit, schedule);
            return {
              identity: store.identity,
              host,
              previewBinding: new PreviewBinding(),
              previewResources,
              ...(source.kind === "directory"
                ? {
                    setResourceScope: async (scope: LocalDirectoryHandle) => {
                      previewResources.setPackages(
                        await DirectoryPackageResources.open(
                          scope,
                          source.handle,
                        ),
                      );
                    },
                  }
                : {}),
              dispose: () => binding.free(),
            };
          } catch (error) {
            await backend.close();
            throw error;
          }
        },
      );
    },
  );
}
let started = false;
self.addEventListener("message", (event: MessageEvent) => {
  if (event.data?.kind !== "initialize" || started) return;
  started = true;
  void start(event.data.source).catch((error) =>
    self.postMessage({ kind: "fatal", error: encodeError(error) }),
  );
});
