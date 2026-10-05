import init, {
  render_preview,
  preview_resource_requests,
} from "../generated/celestite_core";
import type {
  PreviewCompletion,
  PreviewResource,
  PreviewTask,
  PreviewResourceRequest,
} from "./contract";

const ready = init();
// Attach a handler before initialization completes, so early tasks are retained.
void ready.catch(() => {});
let receive: ((resources: Record<string, PreviewResource>) => void) | undefined;
let running: string | undefined;
self.addEventListener(
  "message",
  async (
    event: MessageEvent<
      | PreviewTask
      | {
          kind: "resources";
          taskId: string;
          resources: Record<string, PreviewResource>;
        }
    >,
  ) => {
    if ("kind" in event.data) {
      if (event.data.taskId === running) receive?.(event.data.resources);
      return;
    }
    const task = event.data;
    running = task.ticket.taskId;
    let completion: PreviewCompletion;
    try {
      await ready;
      task.resources ??= {};
      task.overlays ??= {};
      const overlayBytes = Object.values(task.overlays).reduce(
        (sum, source) => sum + new TextEncoder().encode(source).byteLength,
        0,
      );
      for (let attempt = 0; ; attempt++) {
        const requests: PreviewResourceRequest[] = JSON.parse(
          preview_resource_requests(JSON.stringify(task)),
        );
        if (!requests.length) break;
        if (
          attempt >= 128 ||
          Object.keys(task.resources).length + requests.length > 2048
        )
          throw new Error("预览项目依赖超过容量。请缩小项目配置。");
        const resources = await new Promise<Record<string, PreviewResource>>(
          (resolve) => {
            receive = resolve;
            self.postMessage({ kind: "resources", taskId: running, requests });
          },
        );
        receive = undefined;
        Object.assign(task.resources, resources);
        if (
          overlayBytes +
            Object.values(task.resources).reduce(
              (sum, resource) => sum + (resource.data?.length ?? 0),
              0,
            ) >
          32 * 1024 * 1024
        )
          throw new Error("预览项目输入超过 32 MiB。");
      }
      completion = JSON.parse(render_preview(JSON.stringify(task)));
    } catch (error) {
      completion = {
        taskId: task.ticket.taskId,
        outcome: { kind: "failure", message: String(error) },
      };
    }
    running = undefined;
    self.postMessage(completion);
  },
);
