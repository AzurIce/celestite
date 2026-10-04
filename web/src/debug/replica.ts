import { decodeError } from "../lib/editor/rpc";
import type { InstanceIdentity } from "../lib/editor/contract";

/** One independent Worker and WASM EditorCore per debug instance. */
export class ReplicaCore {
  private worker = new Worker(new URL("./replica-worker.ts", import.meta.url), {
    type: "module",
  });
  private nextId = 0;
  private pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private ready: Promise<unknown>;
  private closed = false;
  constructor(readonly identity: InstanceIdentity) {
    this.worker.addEventListener("message", (event) => {
      const { requestId, result, error } = event.data;
      const task = this.pending.get(requestId);
      if (!task) return;
      this.pending.delete(requestId);
      clearTimeout(task.timer);
      if (error) task.reject(decodeError(error));
      else task.resolve(result);
    });
    this.worker.addEventListener("error", (event) =>
      this.dispose(new Error(event.message || "Replica Worker failed")),
    );
    this.ready = this.request(
      "initialize",
      identity as unknown as Record<string, unknown>,
    );
    void this.ready.catch(() => {});
  }
  private request<T>(
    method: string,
    params: Record<string, unknown>,
  ): Promise<T> {
    if (this.closed) return Promise.reject(new Error("Replica closed"));
    const requestId = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => this.dispose(new Error("Replica Worker timed out")),
        30000,
      );
      this.pending.set(requestId, {
        timer,
        resolve: (value) => resolve(value as T),
        reject,
      });
      try {
        this.worker.postMessage({ requestId, method, params });
      } catch (error) {
        this.pending.delete(requestId);
        clearTimeout(timer);
        reject(error);
      }
    });
  }
  async call<T>(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    await this.ready;
    return this.request<T>(method, params);
  }
  dispose(error = new Error("Replica closed")) {
    this.closed = true;
    this.worker.terminate();
    for (const task of this.pending.values()) {
      clearTimeout(task.timer);
      task.reject(error);
    }
    this.pending.clear();
  }
}
