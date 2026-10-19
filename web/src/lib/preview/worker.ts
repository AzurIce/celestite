import init, {
  render_preview,
  preview_resource_requests,
} from "../editor/generated/celestite_core";
import type { PreviewResource } from "./contract";
import { executePreview } from "./execute";
import type {
  PreviewWorkerRequest,
  PreviewWorkerReply,
} from "./worker-protocol";

const ready = init();
void ready.catch(() => {});
let receive: ((resources: Record<string, PreviewResource>) => void) | undefined;
let running: string | undefined;
self.addEventListener(
  "message",
  async (event: MessageEvent<PreviewWorkerRequest>) => {
    if (event.data.kind === "resources") {
      if (event.data.taskId === running) receive?.(event.data.resources);
      return;
    }
    const task = event.data.task;
    running = task.ticket.taskId;
    const completion = await executePreview(
      task,
      {
        async requests(task) {
          await ready;
          return preview_resource_requests(task);
        },
        render: render_preview,
      },
      (requests) =>
        new Promise((resolve) => {
          receive = resolve;
          self.postMessage({
            kind: "resources",
            taskId: task.ticket.taskId,
            requests,
          } satisfies PreviewWorkerReply);
        }),
    );
    receive = undefined;
    running = undefined;
    self.postMessage({
      kind: "complete",
      completion,
    } satisfies PreviewWorkerReply);
  },
);
