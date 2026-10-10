import type {
  PreviewCompletion,
  PreviewEvent,
  PreviewState,
  PreviewTask,
  PreviewAssets,
  PreviewWorkerMessage,
  DocumentSource,
} from "./contract";
import { PreviewResources } from "./resources";
import { VaultError } from "../vault/errors";
import type {
  DocumentSourceSnapshot,
  PreviewBinding,
} from "../editor/generated/celestite_core";

/** Platform execution only. Rust owns subscriptions, deadlines and applicability. */
export class PreviewHost {
  private states = new Map<string, PreviewState>();
  private worker?: Worker;
  private running?: PreviewTask;
  private timer?: ReturnType<typeof setTimeout>;
  private timeout?: ReturnType<typeof setTimeout>;
  private closed = false;
  private assetSnapshots = new Map<
    string,
    { taskId: string; generation: string; roots: string; assets: PreviewAssets }
  >();
  constructor(
    private source: DocumentSource,
    private binding: PreviewBinding,
    private emit: (event: PreviewEvent) => void,
    private schedule: (task: () => Promise<unknown>) => void,
    private resources: PreviewResources,
    private createExecutor: () => Worker = () =>
      new Worker(new URL("./worker.ts", import.meta.url), {
        type: "module",
        name: "celestite-preview",
      }),
  ) {}
  private drain() {
    for (const event of this.binding.events()) {
      if (event.state) this.states.set(event.documentId, event.state);
      else this.states.delete(event.documentId);
      if (!event.state) this.assetSnapshots.delete(event.documentId);
      this.emit(event);
    }
  }
  private withSource<T>(
    ids: readonly string[],
    consume: (source: DocumentSourceSnapshot) => T,
  ): Promise<T> {
    if (this.closed)
      return Promise.reject(new VaultError("Closed", "预览已关闭。"));
    return this.source(ids, (source) => {
      if (this.closed) throw new VaultError("Closed", "预览已关闭。");
      if (this.binding.synchronize(source)) {
        this.stopWorker();
        this.assetSnapshots.clear();
        this.states.clear();
      }
      try {
        return consume(source);
      } finally {
        this.drain();
      }
    });
  }
  async subscribe(id: string, clientSession: string) {
    return this.withSource([], () => this.binding.subscribe(id, clientSession));
  }
  async unsubscribe(subscriptionId: string, clientSession: string) {
    return this.withSource([], () =>
      this.binding.unsubscribe(subscriptionId, clientSession),
    );
  }
  async link(id: string, taskId: string, target: string) {
    return this.withSource([], () => this.binding.link(id, taskId, target));
  }
  /** Called at the end of each host command and after an executor result. */
  async refresh() {
    if (this.closed) return;
    clearTimeout(this.timer);
    this.timer = undefined;
    await this.withSource([], () => {});
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
    let task: PreviewTask | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        task = await this.withSource(
          this.binding.required_snapshots(next.target.documentId),
          (source) => this.binding.take_task(next.target.documentId, source),
        );
        break;
      } catch (error) {
        if (
          typeof error !== "object" ||
          error === null ||
          !("code" in error) ||
          !["StaleVersion", "NotFound"].includes(String(error.code))
        )
          throw error;
      }
    }
    if (!task) return;
    task.resourceRoot = this.resources.root;
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
      await this.withSource([], () => {
        this.binding.complete({
          taskId: task.ticket.taskId,
          outcome: { kind: "failure", message: String(error) },
        });
      });
    }
  }
  private createWorker() {
    const worker = this.createExecutor();
    worker.addEventListener(
      "message",
      (event: MessageEvent<PreviewWorkerMessage>) => {
        if ("kind" in event.data) void this.readResources(worker, event.data);
        else void this.finish(worker, event.data);
      },
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
  private async readResources(
    worker: Worker,
    message: Extract<PreviewWorkerMessage, { kind: "resources" }>,
  ) {
    if (
      this.closed ||
      this.worker !== worker ||
      this.running?.ticket.taskId !== message.taskId
    )
      return;
    const task = this.running;
    const resources: Record<
      string,
      Awaited<ReturnType<PreviewResources["read"]>>
    > = {};
    // Bound remote IO while leaving the editor command queue available.
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(8, message.requests.length) }, async () => {
        while (next < message.requests.length) {
          if (
            this.closed ||
            this.worker !== worker ||
            this.running?.ticket.taskId !== message.taskId
          )
            return;
          const request = message.requests[next++];
          resources[request.path] = await this.resources.read(request, task);
          (task.resources ??= {})[request.path] = resources[request.path];
        }
      }),
    );
    if (
      !this.closed &&
      this.worker === worker &&
      this.running?.ticket.taskId === message.taskId
    )
      worker.postMessage({
        kind: "resources",
        taskId: message.taskId,
        resources,
      });
  }
  async assets(id: string, taskId: string): Promise<PreviewAssets> {
    return this.withSource([], () => {
      const state = this.binding.state(id);
      const snapshot = this.assetSnapshots.get(id);
      if (
        state.status !== "ready" ||
        state.target.taskId !== taskId ||
        snapshot?.taskId !== taskId
      )
        throw new VaultError("Conflict", "预览资源已过期，请等待预览更新。");
      return snapshot.assets;
    });
  }
  private async finish(
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
    const task = this.running;
    let assets: PreviewAssets | undefined;
    let roots = "";
    if (completion.outcome.kind === "success") {
      try {
        const components = completion.outcome.output.usedComponents ?? [];
        roots = JSON.stringify(
          [
            ...new Set(components.map((component) => component.packageRoot)),
          ].sort(),
        );
        const previous = this.assetSnapshots.get(task.ticket.documentId);
        assets =
          previous?.generation === task.ticket.renderGeneration &&
          previous.roots === roots
            ? previous.assets
            : await this.resources.assets(task, components);
        const total = [...this.assetSnapshots]
          .filter(([id]) => id !== task.ticket.documentId)
          .reduce(
            (sum, [, value]) =>
              sum +
              value.assets.files.reduce(
                (n, file) => n + file.data.byteLength,
                0,
              ),
            0,
          );
        if (
          total +
            assets.files.reduce((sum, file) => sum + file.data.byteLength, 0) >
          64 * 1024 * 1024
        )
          throw new Error("组件资源超过缓存容量，请关闭其他预览。");
      } catch (error) {
        completion = {
          taskId: completion.taskId,
          outcome: { kind: "failure", message: String(error) },
        };
      }
    }
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
      await this.withSource([], () => {
        if (this.running?.ticket.taskId !== completion.taskId) return;
        const id = this.running.ticket.documentId;
        this.running = undefined;
        if (terminate) this.stopWorker();
        const accepted = this.binding.complete(completion);
        if (accepted && assets)
          this.assetSnapshots.set(id, {
            taskId: completion.taskId,
            generation: task.ticket.renderGeneration,
            roots,
            assets,
          });
      });
    });
  }
  private interrupt() {
    // Terminating the executor must also release its core task, including a
    // stale task still occupying the single-flight slot after text/environment
    // changes. Otherwise no executor remains to deliver that task's completion.
    try {
      if (this.running)
        this.binding.complete({
          taskId: this.running.ticket.taskId,
          outcome: { kind: "failure", message: "预览执行器已重启，请重试。" },
        });
    } finally {
      this.stopWorker();
    }
  }
  async retry(id: string) {
    return this.withSource([], () => {
      this.interrupt();
      this.assetSnapshots.delete(id);
      return this.binding.retry(id);
    });
  }
  async invalidateProject() {
    await this.withSource([], () => {
      this.interrupt();
      this.assetSnapshots.clear();
      this.binding.invalidate_project();
    });
  }
  private stopWorker() {
    clearTimeout(this.timeout);
    this.timeout = undefined;
    this.worker?.terminate();
    this.worker = undefined;
    this.running = undefined;
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.timer);
    this.states.clear();
    this.assetSnapshots.clear();
    this.stopWorker();
    this.binding.clear();
    this.binding.free();
  }
}
