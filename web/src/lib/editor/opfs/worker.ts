import init, { EditorBinding } from "../generated/celestite_core";
import { openOpfsVault } from "../../vault/opfs";
import { VaultError } from "../../vault/errors";
import { OpfsInstanceStore } from "./store";
import { createOpfsIo } from "./io";
import { EditorHost } from "../runtime/host";
import { encodeError } from "../rpc";
import { serveEditorWorker } from "../runtime/service";
async function start() {
  await navigator.locks.request(
    "celestite.editor.instance:default",
    { ifAvailable: true },
    async (lock) => {
      if (!lock)
        throw new VaultError(
          "Busy",
          "默认 Vault 已在另一标签页中打开，请先关闭该标签页。",
        );
      await serveEditorWorker(async (emit, schedule) => {
        await init();
        const store = await OpfsInstanceStore.open();
        const backend = await openOpfsVault();
        const binding = await EditorBinding.open(
          JSON.stringify(store.identity),
          createOpfsIo(store, backend),
        );
        return {
          identity: store.identity,
          host: new EditorHost(binding, backend, emit, schedule),
          dispose: () => binding.free(),
        };
      });
    },
  );
}
void start().catch((error) =>
  self.postMessage({ kind: "fatal", error: encodeError(error) }),
);
