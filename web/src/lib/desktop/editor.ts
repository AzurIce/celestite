import { VaultError } from "../vault/errors";
import type { VaultBackend, Entry } from "../vault/types";
import { fileBackend } from "../editor/files";
import { coreValue, type CorePort } from "../editor/core";
import { LocalEditorSession } from "../editor/local/session";
import { RemoteEditorSession } from "../editor/remote/editor-session";
import { serveEditor } from "../editor/runtime/service";
import { EditorClient, encodeError } from "../editor/rpc";
import { ClientDocuments } from "../editor/client/documents";
import { PreviewResources } from "../preview/resources";
import { openHttpVault } from "../vault/http";
import type { InstanceIdentity } from "../editor/contract";
import { desktopInvoke, type DesktopInvoke } from "./platform";
import { nativePreview, nativePreviewExecutor } from "./preview";
import { NativeObservation } from "./observation";

const nativeClientId = crypto.randomUUID();
interface NativeEditor {
  identity: InstanceIdentity;
  documents: ClientDocuments;
  backend: VaultBackend;
  root: string | null;
}
const nativeEditors = new Map<string, Promise<NativeEditor>>();

export type NativeEditorSource =
  | { kind: "default" }
  | { kind: "directory"; path: string }
  | { kind: "remote"; identity: InstanceIdentity };
export interface NativeEditorDescriptor {
  handle: string;
  identity: InstanceIdentity;
  root: string | null;
}

function nativeCore(
  handle: string,
  invoke: DesktopInvoke = desktopInvoke,
): CorePort {
  return {
    call: (method, params) =>
      invoke("desktop_core", { handle, method, params }),
  };
}
function nativeBackend(core: CorePort): VaultBackend {
  return fileBackend(
    async (method, params) => {
      const result = coreValue(await core.call("file", { ...params, method }));
      if (method === "readFile") return new Uint8Array(result as number[]);
      if (method === "readFileSnapshot") {
        const file = result as { data: number[]; revision: string };
        return { data: new Uint8Array(file.data), revision: file.revision };
      }
      return result;
    },
    async () => () => {},
    async () => {},
  );
}

export async function openNativeEditor(
  source: NativeEditorSource,
  invoke: DesktopInvoke = desktopInvoke,
) {
  const descriptor = await invoke<NativeEditorDescriptor>("desktop_open", {
    clientId: nativeClientId,
    source,
  });
  return cachedNativeEditor(descriptor, undefined, invoke);
}
export async function openNativeRemoteEditor(
  url: string,
  backend: VaultBackend,
  invoke: DesktopInvoke = desktopInvoke,
) {
  let remote: Awaited<ReturnType<typeof openHttpVault>> | undefined;
  let transferred = false;
  try {
    remote = await openHttpVault(url);
    const vault = remote.descriptor.vault;
    if (
      !vault?.vaultId ||
      !vault.historyId ||
      !remote.descriptor.capabilities.websocketSync
    )
      throw new VaultError(
        "Unsupported",
        "远端服务需要升级，以支持统一编辑器与预览。",
      );
    const descriptor = await invoke<NativeEditorDescriptor>("desktop_open", {
      clientId: nativeClientId,
      source: {
        kind: "remote",
        identity: { instanceId: crypto.randomUUID(), vault },
      },
    });
    transferred = true;
    return await cachedNativeEditor(
      descriptor,
      { ...remote, original: backend },
      invoke,
    );
  } catch (error) {
    if (!transferred)
      await Promise.allSettled([remote?.backend.close(), backend.close()]);
    throw error;
  }
}

function cachedNativeEditor(
  descriptor: NativeEditorDescriptor,
  remote:
    | (Awaited<ReturnType<typeof openHttpVault>> & { original: VaultBackend })
    | undefined,
  invoke: DesktopInvoke,
): Promise<NativeEditor> {
  const existing = nativeEditors.get(descriptor.handle);
  if (existing) return existing;
  const editor = startNativeEditor(descriptor, remote, invoke);
  nativeEditors.set(descriptor.handle, editor);
  void editor.catch(() => {
    nativeEditors.delete(descriptor.handle);
  });
  return editor;
}

async function startNativeEditor(
  descriptor: NativeEditorDescriptor,
  remote:
    | (Awaited<ReturnType<typeof openHttpVault>> & { original: VaultBackend })
    | undefined,
  invoke: DesktopInvoke,
): Promise<NativeEditor> {
  let detachRuntime: (() => void) | undefined;
  const channel = new MessageChannel();
  channel.port1.start();
  channel.port2.start();
  const closeChannel = () => {
    channel.port1.close();
    channel.port2.close();
  };
  const client = new EditorClient(channel.port1);
  let stopObservation = () => {};
  let cleanupPromise: Promise<void> | undefined;
  const cleanup = () => {
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = Promise.resolve().then(async () => {
      if (remote)
        await Promise.all(
          [...new Set([remote.backend, remote.original])].map((backend) =>
            backend.close(),
          ),
        );
    });
    stopObservation();
    nativeEditors.delete(descriptor.handle);
    return cleanupPromise;
  };
  const lifetime = serveEditor(
    channel.port2,
    async (emit, schedule) => {
      const core = nativeCore(descriptor.handle, invoke);
      const backend = remote?.backend ?? nativeBackend(core);
      const host = remote
        ? new RemoteEditorSession(
            core,
            remote.backend,
            remote.descriptor,
            emit,
            schedule,
          )
        : new LocalEditorSession(core, backend, emit, schedule, true);
      if (host instanceof RemoteEditorSession) await host.connect();
      if (host instanceof LocalEditorSession) {
        // External file observation uses exactly the same IME and conflict rules as browser directories.
        const observation = new NativeObservation(
          schedule,
          () =>
            invoke<boolean>("desktop_changes", {
              handle: descriptor.handle,
            }),
          () => host.observeFiles(),
        );
        const poll = () => observation.request();
        // Focus also reconciles missed events while watches were being registered.
        const focus = () => observation.request(true);
        const timer = setInterval(poll, 1500);
        if (typeof window !== "undefined")
          window.addEventListener("focus", focus);
        stopObservation = () => {
          observation.stop();
          clearInterval(timer);
          if (typeof window !== "undefined")
            window.removeEventListener("focus", focus);
        };
      }
      const packages = remote
        ? remote.backend.packageResources(remote.descriptor)
        : descriptor.root
          ? {
              root: descriptor.root,
              read: (
                request: import("../preview/contract").PreviewResourceRequest,
                task: import("../preview/contract").PreviewTask,
              ) =>
                invoke<import("../preview/contract").PreviewResource>(
                  "desktop_package_read",
                  { handle: descriptor.handle, task, request },
                ),
              readDir: (
                path: string,
                task: import("../preview/contract").PreviewTask,
              ) =>
                invoke<Entry[]>("desktop_package_directory", {
                  handle: descriptor.handle,
                  task,
                  path,
                }),
            }
          : undefined;
      return {
        identity: descriptor.identity,
        host,
        previewBinding: nativePreview(descriptor.handle, invoke),
        previewResources: new PreviewResources(backend, packages),
        createPreviewExecutor: () => nativePreviewExecutor(invoke),
        invalidateResourcesOnTree: true,
        releaseOwner: () =>
          invoke<void>("desktop_close", { handle: descriptor.handle }),
        dispose: cleanup,
      };
    },
    (detach) => {
      detachRuntime = detach;
    },
  );
  void lifetime.catch((error) =>
    channel.port2.postMessage({ kind: "fatal", error: encodeError(error) }),
  );
  try {
    const identity = await client.ready;
    const documents = new ClientDocuments(
      client,
      () => {
        detachRuntime?.();
        void cleanup().catch(() => {});
        closeChannel();
      },
      !!remote,
    );
    if (remote)
      documents.reconnect = (discard = false) =>
        documents.reconnectSession(discard);
    return {
      identity,
      documents,
      backend: documents.treeBackend,
      root: descriptor.root,
    };
  } catch (error) {
    client.dispose();
    closeChannel();
    try {
      await invoke("desktop_close", { handle: descriptor.handle });
      await cleanup();
    } catch {
      // A failed native close retains its owner; preserve the startup failure.
    }
    throw error;
  }
}
