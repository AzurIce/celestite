import init, { render_preview } from "../generated/celestite_core";
import type { PreviewCompletion, PreviewTask } from "./contract";

const ready = init();
// Attach a handler before initialization completes, so early tasks are retained.
void ready.catch(() => {});
self.addEventListener("message", async (event: MessageEvent<PreviewTask>) => {
  const task = event.data;
  let completion: PreviewCompletion;
  try {
    await ready;
    completion = JSON.parse(render_preview(JSON.stringify(task)));
  } catch (error) {
    completion = {
      taskId: task.ticket.taskId,
      outcome: { kind: "failure", message: String(error) },
    };
  }
  self.postMessage(completion);
});
