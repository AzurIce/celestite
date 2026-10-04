import init, { EditorBinding } from "./generated/celestite_core";
import { openOpfsVault } from "../vault/opfs";
import { VaultError } from "../vault/errors";
import { vaultPath } from "../vault/path";
import { OpfsInstanceStore } from "./opfs-store";
import { createOpfsIo } from "./opfs-io";
import { OpfsEditorHost } from "./opfs-host";
import { encodeError } from "./rpc";
import type {
  SelectionContext,
  TextEdit,
  Version,
  WorkerMessage,
  WorkerRequest,
} from "./contract";

const port = self as unknown as {
  postMessage(message: WorkerMessage): void;
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<WorkerRequest>) => void,
  ): void;
};
const sessionId = crypto.randomUUID();
let host: OpfsEditorHost;
let queue: Promise<unknown> = Promise.resolve();
let closing = false;
let release!: () => void;
function enqueue(task: () => Promise<unknown>) {
  const result = queue.then(task);
  queue = result.catch(() => {});
  return result;
}
port.addEventListener("message", (event) => {
  const request = event.data;
  if (!request || request.kind !== "request") return;
  void enqueue(async () => {
    if (!host || closing || request.sessionId !== sessionId)
      throw new VaultError("Closed", "编辑服务会话无效或正在关闭。");
    const p = request.params;
    switch (request.method) {
      case "open":
        return host.open(vaultPath(String(p.path)));
      case "edit":
        return host.edit(
          String(p.id),
          p.version as Version,
          p.edits as TextEdit[],
          p.context as SelectionContext,
          String(p.userEvent),
        );
      case "undo":
        return host.undo(
          String(p.id),
          p.context as SelectionContext,
          Boolean(p.redo),
        );
      case "retry_history":
        return host.retryHistory(String(p.id));
      case "save":
        return host.save(String(p.id));
      case "resolve":
        return host.resolve(String(p.id), p.action as "overwrite" | "discard");
      case "flush":
        return host.flush();
      case "file":
        return host.fileOperation(String(p.method), p);
      case "close":
        closing = true;
        try {
          await host.close();
        } catch (error) {
          closing = false;
          throw error;
        }
        release();
        return;
      default:
        throw new VaultError("Unsupported", "未知编辑服务命令。");
    }
  }).then(
    (result) =>
      port.postMessage({ kind: "reply", requestId: request.requestId, result }),
    (error) =>
      port.postMessage({
        kind: "reply",
        requestId: request.requestId,
        error: encodeError(error),
      }),
  );
});
async function start() {
  // This ownership lock differs from the short file-operation lock. External
  // file IO can still be detected by conditional writes, but two kernels cannot
  // concurrently own the same history journal.
  await navigator.locks.request(
    "celestite.editor.instance:default",
    { ifAvailable: true },
    async (lock) => {
      if (!lock)
        throw new VaultError(
          "Busy",
          "默认 Vault 已在另一标签页中打开，请先关闭该标签页。",
        );
      await init();
      const store = await OpfsInstanceStore.open();
      const backend = await openOpfsVault();
      const binding = await EditorBinding.open(
        JSON.stringify(store.identity),
        createOpfsIo(store, backend),
      );
      host = new OpfsEditorHost(
        binding,
        backend,
        (event) => port.postMessage(event),
        (task) => {
          if (!closing)
            void enqueue(task).catch((error) =>
              port.postMessage({ kind: "fatal", error: encodeError(error) }),
            );
        },
      );
      const lifetime = new Promise<void>((resolve) => {
        release = resolve;
      });
      port.postMessage({ kind: "ready", identity: store.identity, sessionId });
      await lifetime;
      binding.free();
    },
  );
}
void start().catch((error) =>
  port.postMessage({ kind: "fatal", error: encodeError(error) }),
);
