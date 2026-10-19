import type {
  PreviewCompletion,
  PreviewResourceRequest,
  PreviewTask,
  PreviewResourceReader,
} from "./contract";

/** Stop waiting for IPC promptly, and never start its next stage after abort. */
async function withAbort<T>(
  operation: () => T | Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  if (!signal) return operation();
  let abort!: () => void;
  try {
    const value = await new Promise<T>((resolve, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      Promise.resolve()
        .then(() => {
          signal.throwIfAborted();
          return operation();
        })
        .then(resolve, reject);
    });
    signal.throwIfAborted();
    return value;
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

/** Shared executor resource loop; rendering policy stays in Rust on each platform. */
export async function executePreview(
  task: PreviewTask,
  engine: {
    requests(
      task: PreviewTask,
    ): PreviewResourceRequest[] | Promise<PreviewResourceRequest[]>;
    render(task: PreviewTask): PreviewCompletion | Promise<PreviewCompletion>;
  },
  read: PreviewResourceReader,
  signal?: AbortSignal,
): Promise<PreviewCompletion> {
  try {
    task.resources ??= {};
    task.overlays ??= {};
    const overlayBytes = Object.values(task.overlays).reduce(
      (sum, source) => sum + new TextEncoder().encode(source).byteLength,
      0,
    );
    for (let attempt = 0; ; attempt++) {
      const requests = await withAbort(() => engine.requests(task), signal);
      if (!requests.length) break;
      if (
        attempt >= 128 ||
        Object.keys(task.resources).length + requests.length > 2048
      )
        throw new Error("预览项目依赖超过容量。请缩小项目配置。");
      Object.assign(
        task.resources,
        await withAbort(() => read(requests), signal),
      );
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
    return await withAbort(() => engine.render(task), signal);
  } catch (error) {
    signal?.throwIfAborted();
    return {
      taskId: task.ticket.taskId,
      outcome: { kind: "failure", message: String(error) },
    };
  }
}
