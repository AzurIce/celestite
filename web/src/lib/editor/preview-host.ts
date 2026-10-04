import type {
  PreviewCompletion,
  PreviewCoreMethods,
  PreviewEvent,
  PreviewState,
  PreviewTask,
} from "./preview-contract";

type Execute = <K extends keyof PreviewCoreMethods>(
  method: K,
  params: PreviewCoreMethods[K]["params"],
) => Promise<PreviewCoreMethods[K]["result"]>;

/** Platform execution only. Rust owns subscriptions, deadlines and applicability. */
export class PreviewHost {
  private states = new Map<string, PreviewState>();
  private worker?: Worker;
  private running?: PreviewTask;
  private timer?: ReturnType<typeof setTimeout>;
  private timeout?: ReturnType<typeof setTimeout>;
  private closed = false;
  constructor(
    private execute: Execute,
    private emit: (event: PreviewEvent) => void,
    private schedule: (task: () => Promise<unknown>) => void,
  ) {}
  private async drain() {
    for (const event of await this.execute("preview_events", {})) {
      if (event.state) this.states.set(event.documentId, event.state);
      else this.states.delete(event.documentId);
      this.emit(event);
    }
  }
  /** Called at the end of each host command and after an executor result. */
  async refresh() {
    if (this.closed) return;
    clearTimeout(this.timer);
    this.timer = undefined;
    await this.drain();
    if (this.running && !this.states.has(this.running.ticket.documentId))
      this.stopWorker();
    if (!this.states.size) {
      this.stopWorker();
      return;
    }
    if (this.running) return;
    const next = [...this.states.values()]
      .filter((state) => state.status === "pending" && state.dueAt !== null)
      .sort((a, b) => a.dueAt! - b.dueAt!)[0];
    if (!next) return;
    const delay = next.dueAt! - Date.now();
    if (delay > 0) {
      this.timer = setTimeout(() => this.schedule(() => this.refresh()), delay);
      return;
    }
    const task = await this.execute("preview_take_task", {
      id: next.target.documentId,
    });
    await this.drain();
    if (!task) return;
    this.running = task;
    try {
      const worker = (this.worker ??= this.createWorker());
      this.timeout = setTimeout(
        () =>
          this.finish(
            worker,
            {
              taskId: task.ticket.taskId,
              outcome: { kind: "failure", message: "预览计算超时，请重试。" },
            },
            true,
          ),
        30000,
      );
      worker.postMessage(task);
    } catch (error) {
      this.running = undefined;
      this.stopWorker();
      await this.execute("preview_complete", {
        completion: {
          taskId: task.ticket.taskId,
          outcome: { kind: "failure", message: String(error) },
        },
      });
      await this.drain();
    }
  }
  private createWorker() {
    const worker = new Worker(new URL("./preview-worker.ts", import.meta.url), {
      type: "module",
      name: "celestite-preview",
    });
    worker.addEventListener(
      "message",
      (event: MessageEvent<PreviewCompletion>) =>
        this.finish(worker, event.data),
    );
    worker.addEventListener("error", (event) => {
      event.preventDefault();
      if (this.running)
        this.finish(
          worker,
          {
            taskId: this.running.ticket.taskId,
            outcome: {
              kind: "failure",
              message: event.message || "预览 Worker 无法启动。",
            },
          },
          true,
        );
    });
    worker.addEventListener("messageerror", () => {
      if (this.running)
        this.finish(
          worker,
          {
            taskId: this.running.ticket.taskId,
            outcome: { kind: "failure", message: "无法读取预览计算结果。" },
          },
          true,
        );
    });
    return worker;
  }
  private finish(
    worker: Worker,
    completion: PreviewCompletion,
    terminate = false,
  ) {
    if (
      this.closed ||
      this.worker !== worker ||
      this.running?.ticket.taskId !== completion.taskId
    )
      return;
    clearTimeout(this.timeout);
    this.schedule(async () => {
      if (
        this.closed ||
        this.worker !== worker ||
        this.running?.ticket.taskId !== completion.taskId
      )
        return;
      this.running = undefined;
      if (terminate) this.stopWorker();
      await this.execute("preview_complete", { completion });
    });
  }
  async retry(id: string) {
    // A shared executor may be processing another subscribed document. Report
    // its interruption before revoking this executor, so it cannot remain busy.
    if (this.running)
      await this.execute("preview_complete", {
        completion: {
          taskId: this.running.ticket.taskId,
          outcome: { kind: "failure", message: "预览执行器已重启，请重试。" },
        },
      });
    this.stopWorker();
    return this.execute("preview_retry", { id });
  }
  private stopWorker() {
    clearTimeout(this.timeout);
    this.timeout = undefined;
    this.worker?.terminate();
    this.worker = undefined;
    this.running = undefined;
  }
  close() {
    this.closed = true;
    clearTimeout(this.timer);
    this.states.clear();
    this.stopWorker();
  }
}
