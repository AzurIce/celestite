import type {
  PreviewCompletion,
  PreviewEvent,
  PreviewState,
  PreviewTask,
  PreviewAssets,
  PreviewResourceRequest,
  PreviewResource,
  DocumentSource,
  PreviewPort,
  PreviewExecutor,
} from "./contract";
import { PreviewResources } from "./resources";
import { VaultError } from "../vault/errors";
import type { DocumentSourceSnapshot } from "../editor/generated/celestite_core";
import { browserPreviewExecutor } from "./browser-executor";

interface PreviewRun {
  task: PreviewTask;
  abort: AbortController;
  completion: number;
}

/** Platform execution only. Rust owns subscriptions, deadlines and applicability. */
export class PreviewHost {
  private states = new Map<string, PreviewState>();
  private executor?: PreviewExecutor;
  private running?: PreviewRun;
  private timer?: ReturnType<typeof setTimeout>;
  private timeout?: ReturnType<typeof setTimeout>;
  private closed = false;
  private paused = false;
  private assetSnapshots = new Map<
    string,
    { taskId: string; generation: string; roots: string; assets: PreviewAssets }
  >();
  constructor(
    private source: DocumentSource,
    private binding: PreviewPort,
    private emit: (event: PreviewEvent) => void,
    private schedule: (task: () => Promise<unknown>) => void,
    private resources: PreviewResources,
    private createExecutor: () => PreviewExecutor = browserPreviewExecutor,
  ) {}
  private async drain() {
    for (const event of await this.binding.events()) {
      if (event.state) this.states.set(event.documentId, event.state);
      else this.states.delete(event.documentId);
      if (!event.state) this.assetSnapshots.delete(event.documentId);
      this.emit(event);
    }
  }
  private withSource<T>(
    ids: readonly string[],
    consume: (source: DocumentSourceSnapshot) => T | Promise<T>,
  ): Promise<T> {
    if (this.closed)
      return Promise.reject(new VaultError("Closed", "预览已关闭。"));
    return this.source(ids, async (source) => {
      if (this.closed) throw new VaultError("Closed", "预览已关闭。");
      if (await this.binding.synchronize(source)) {
        this.stopExecution();
        this.assetSnapshots.clear();
        this.states.clear();
      }
      try {
        return await consume(source);
      } finally {
        await this.drain();
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
    if (this.closed || this.paused) return;
    clearTimeout(this.timer);
    this.timer = undefined;
    await this.withSource([], () => {});
    if (this.paused) return;
    if (this.running && !this.states.has(this.running.task.ticket.documentId))
      this.stopExecution();
    if (!this.states.size) {
      this.stopExecution();
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
          await this.binding.required_snapshots(next.target.documentId),
          (source) =>
            this.paused
              ? undefined
              : this.binding.take_task(next.target.documentId, source),
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
    const run: PreviewRun = {
      task,
      abort: new AbortController(),
      completion: 0,
    };
    this.running = run;
    try {
      const executor = (this.executor ??= this.createExecutor());
      this.timeout = setTimeout(
        () =>
          void this.finish(
            run,
            {
              taskId: task.ticket.taskId,
              outcome: { kind: "failure", message: "预览计算超时，请重试。" },
            },
            true,
          ),
        30000,
      );
      void executor
        .execute(
          task,
          (requests) => this.readResources(run, requests),
          run.abort.signal,
        )
        .then(
          (completion) => {
            if (!run.abort.signal.aborted) void this.finish(run, completion);
          },
          (error) => {
            if (!run.abort.signal.aborted)
              void this.finish(
                run,
                {
                  taskId: task.ticket.taskId,
                  outcome: { kind: "failure", message: String(error) },
                },
                true,
              );
          },
        );
    } catch (error) {
      await this.finish(
        run,
        {
          taskId: task.ticket.taskId,
          outcome: { kind: "failure", message: String(error) },
        },
        true,
      );
    }
  }
  private current(run: PreviewRun) {
    return !this.closed && this.running === run;
  }
  private async readResources(
    run: PreviewRun,
    requests: PreviewResourceRequest[],
  ): Promise<Record<string, PreviewResource>> {
    const { task, abort } = run;
    abort.signal.throwIfAborted();
    const resources: Record<string, PreviewResource> = {};
    // Bound remote IO while leaving the editor command queue available.
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(8, requests.length) }, async () => {
        while (next < requests.length) {
          abort.signal.throwIfAborted();
          const request = requests[next++];
          const resource = await this.resources.read(
            request,
            task,
            abort.signal,
          );
          abort.signal.throwIfAborted();
          resources[request.path] = resource;
          (task.resources ??= {})[request.path] = resource;
        }
      }),
    );
    abort.signal.throwIfAborted();
    return resources;
  }
  async assets(id: string, taskId: string): Promise<PreviewAssets> {
    return this.withSource([], async () => {
      const state = await this.binding.state(id);
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
    run: PreviewRun,
    completion: PreviewCompletion,
    cancel = false,
  ) {
    if (!this.current(run) || run.task.ticket.taskId !== completion.taskId)
      return;
    const token = ++run.completion;
    if (cancel) {
      run.abort.abort();
      this.executor?.dispose?.();
      this.executor = undefined;
    }
    const task = run.task;
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
            : await this.resources.assets(task, components, run.abort.signal);
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
    if (!this.current(run) || run.completion !== token) return;
    clearTimeout(this.timeout);
    this.schedule(async () => {
      if (!this.current(run) || run.completion !== token) return;
      await this.withSource([], async () => {
        if (!this.current(run) || run.completion !== token) return;
        const id = task.ticket.documentId;
        this.running = undefined;
        const accepted = await this.binding.complete(completion);
        if (accepted && assets && !this.closed && !run.abort.signal.aborted)
          this.assetSnapshots.set(id, {
            taskId: completion.taskId,
            generation: task.ticket.renderGeneration,
            roots,
            assets,
          });
      });
    });
  }
  private async interrupt() {
    // Cancelling execution must also release its core task, including a
    // stale task still occupying the single-flight slot after text/environment
    // changes. Otherwise no executor remains to deliver that task's completion.
    try {
      if (this.running)
        await this.binding.complete({
          taskId: this.running.task.ticket.taskId,
          outcome: { kind: "failure", message: "预览执行器已重启，请重试。" },
        });
    } finally {
      this.stopExecution();
    }
  }
  async retry(id: string) {
    return this.withSource([], async () => {
      await this.interrupt();
      this.assetSnapshots.delete(id);
      return this.binding.retry(id);
    });
  }
  async invalidateProject() {
    await this.withSource([], async () => {
      await this.interrupt();
      this.assetSnapshots.clear();
      await this.binding.invalidate_project();
    });
  }
  resume() {
    this.paused = false;
  }
  async pause() {
    this.paused = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    await this.withSource([], async () => {
      const id = this.running?.task.ticket.documentId;
      await this.interrupt();
      if (id) await this.binding.retry(id);
    });
  }
  private stopExecution() {
    clearTimeout(this.timeout);
    this.timeout = undefined;
    this.running?.abort.abort();
    this.executor?.dispose?.();
    this.executor = undefined;
    this.running = undefined;
  }
  dispose() {
    this.closed = true;
    clearTimeout(this.timer);
    this.states.clear();
    this.assetSnapshots.clear();
    this.stopExecution();
  }
  async close() {
    if (this.closed) return;
    this.dispose();
    await this.binding.clear();
    await this.binding.free();
  }
}
