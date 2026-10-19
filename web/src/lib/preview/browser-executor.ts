import type { PreviewExecutor, PreviewCompletion } from "./contract";
import type {
  PreviewWorkerRequest,
  PreviewWorkerReply,
} from "./worker-protocol";

/** Only this browser boundary knows about Worker events and wire messages. */
export interface PreviewWorker extends EventTarget {
  postMessage(message: PreviewWorkerRequest): void;
  terminate(): void;
}

export function browserPreviewExecutor(
  createWorker: () => PreviewWorker = () =>
    new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
      name: "celestite-preview",
    }),
): PreviewExecutor {
  let worker: PreviewWorker | undefined;
  let cancel: (() => void) | undefined;
  const terminate = () => {
    worker?.terminate();
    worker = undefined;
  };
  return {
    execute(task, readResources, signal) {
      return new Promise<PreviewCompletion>((resolve, reject) => {
        signal.throwIfAborted();
        if (cancel) throw new Error("预览执行器已有运行中的任务。");
        const current = (worker ??= createWorker());
        let settled = false;
        const cleanup = () => {
          settled = true;
          current.removeEventListener("message", message);
          current.removeEventListener("error", error);
          current.removeEventListener("messageerror", messageError);
          signal.removeEventListener("abort", abort);
          cancel = undefined;
        };
        const fail = (reason: unknown) => {
          if (settled) return;
          cleanup();
          terminate();
          reject(reason);
        };
        const abort = () => fail(signal.reason);
        const message = (event: Event) => {
          const reply = (event as MessageEvent<PreviewWorkerReply>).data;
          if (settled) return;
          if (reply.kind === "complete") {
            if (reply.completion.taskId !== task.ticket.taskId) return;
            cleanup();
            resolve(reply.completion);
          } else if (reply.taskId === task.ticket.taskId) {
            void Promise.resolve()
              .then(() => {
                if (settled)
                  throw new DOMException("预览任务已完成。", "AbortError");
                signal.throwIfAborted();
                return readResources(reply.requests);
              })
              .then((resources) => {
                if (!settled && !signal.aborted) {
                  try {
                    current.postMessage({
                      kind: "resources",
                      taskId: task.ticket.taskId,
                      resources,
                    });
                  } catch (reason) {
                    fail(reason);
                  }
                }
              }, fail);
          }
        };
        const error = (event: Event) => {
          event.preventDefault();
          fail(
            new Error(
              (event as ErrorEvent).message || "预览 Worker 无法启动。",
            ),
          );
        };
        const messageError = () => fail(new Error("无法读取预览计算结果。"));
        cancel = () => fail(new DOMException("预览已关闭。", "AbortError"));
        current.addEventListener("message", message);
        current.addEventListener("error", error);
        current.addEventListener("messageerror", messageError);
        signal.addEventListener("abort", abort, { once: true });
        try {
          current.postMessage({ kind: "execute", task });
        } catch (reason) {
          fail(reason);
        }
      });
    },
    dispose() {
      cancel?.();
      terminate();
    },
  };
}
