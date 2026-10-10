/** An exclusive async call boundary. A failed task does not poison later calls. */
export class TaskQueue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task);
    this.tail = result.catch(() => {});
    return result;
  }

  /** Wait for already queued work; detached IO has explicitly yielded this queue. */
  idle() {
    return this.tail;
  }

  /** Start under the lease, but yield it before waiting for detached IO. */
  start<T>(task: () => Promise<T>): Promise<T> {
    return this.run(async () => {
      const pending = task();
      void pending.catch(() => {});
      return { pending };
    }).then(({ pending }) => pending);
  }
}
