import init, { MemoryEditorBinding } from "../generated/celestite_core";
import { openHttpVault } from "../../vault/http";
import { VaultError } from "../../vault/errors";
import { RemoteEditorHost } from "./host";
import { serveEditor, type EditorServicePort } from "../runtime/service";
import { encodeError } from "../rpc";
let initialized = false;
self.addEventListener("message", (event) => {
  if (event.data?.kind !== "initialize" || initialized) return;
  initialized = true;
  const { url } = event.data as { url: string };
  void serveEditor(
    self as unknown as EditorServicePort,
    async (emit, schedule) => {
      const { backend, descriptor } = await openHttpVault(url);
      try {
        const vault = descriptor.vaultIdentity;
        if (
          !vault?.id ||
          !vault.historyId ||
          !descriptor.capabilities.websocketSync
        )
          throw new VaultError(
            "Unsupported",
            "远端服务需要升级，以支持统一编辑器与预览。",
          );
        const identity = {
          instanceId: crypto.randomUUID(),
          vault: { vaultId: vault.id, historyId: vault.historyId },
        };
        await init();
        const binding = await MemoryEditorBinding.open(
          JSON.stringify(identity),
        );
        const host = new RemoteEditorHost(
          binding,
          backend,
          descriptor,
          emit,
          schedule,
        );
        try {
          await host.connect();
        } catch (error) {
          binding.free();
          throw error;
        }
        return { identity, host, dispose: () => binding.free() };
      } catch (error) {
        await backend.close();
        throw error;
      }
    },
  ).catch((error) =>
    self.postMessage({ kind: "fatal", error: encodeError(error) }),
  );
});
