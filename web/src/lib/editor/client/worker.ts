import { VaultError } from "../../vault/errors";
import type { VaultBackend } from "../../vault/types";
import type { LocalEditorSource } from "../local/worker";
import { EditorClient } from "../rpc";

/** Browser Worker lifetime shared by the local and remote document factories. */
export async function startEditorWorker(
  worker: Worker,
  initialize:
    | { kind: "initialize"; source: LocalEditorSource }
    | { kind: "initialize"; url: string },
  backend?: Pick<VaultBackend, "close">,
) {
  const client = new EditorClient(worker);
  const failed = () =>
    client.fail(
      new VaultError(
        "IO",
        `${backend ? "远端编辑" : "编辑"} Worker 已停止，尚未确认的输入仍保留。`,
      ),
    );
  const stop = () => {
    worker.removeEventListener("error", failed);
    worker.removeEventListener("messageerror", failed);
    worker.terminate();
  };
  worker.addEventListener("error", failed);
  worker.addEventListener("messageerror", failed);
  try {
    worker.postMessage(initialize);
    const identity = await client.ready;
    return {
      client,
      identity,
      terminate: () => {
        stop();
        void backend?.close().catch(() => {});
      },
    };
  } catch (error) {
    client.dispose();
    stop();
    try {
      await backend?.close();
    } catch {
      // Cleanup must not hide the startup failure.
    }
    throw error;
  }
}
