import init, {
  MemoryEditorBinding,
} from "../lib/editor/generated/celestite_core";
import { decodeError, encodeError } from "../lib/editor/rpc";

let core: MemoryEditorBinding | undefined;
let queue: Promise<unknown> = Promise.resolve();
self.addEventListener("message", (event) => {
  const { requestId, method, params } = event.data;
  const task = queue.then(async () => {
    if (method === "initialize") {
      if (core) throw new Error("Replica already initialized");
      await init();
      core = await MemoryEditorBinding.open(JSON.stringify(params));
      return null;
    }
    if (!core) throw new Error("Replica is not initialized");
    return JSON.parse(await core.execute(method, JSON.stringify(params)));
  });
  queue = task.catch(() => {});
  void task.then(
    (result) => self.postMessage({ requestId, result }),
    (error) => {
      try {
        error = decodeError(JSON.parse(String(error)));
      } catch {
        /* JS error */
      }
      self.postMessage({ requestId, error: encodeError(error) });
    },
  );
});
