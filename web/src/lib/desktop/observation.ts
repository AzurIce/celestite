/** Coalesce native notifications without filling the serialized editor queue. */
export class NativeObservation {
  private queued = false;
  private pending = false;
  private forced = false;
  private stopped = false;

  constructor(
    private schedule: (task: () => Promise<unknown>) => void,
    private changed: () => Promise<boolean>,
    private observe: () => Promise<void>,
  ) {}

  request(force = false) {
    if (this.stopped) return;
    this.pending = true;
    this.forced ||= force;
    this.enqueue();
  }

  stop() {
    this.stopped = true;
    this.pending = false;
    this.forced = false;
  }

  private enqueue() {
    if (this.stopped || this.queued || !this.pending) return;
    this.queued = true;
    this.schedule(async () => {
      if (this.stopped) return;
      const force = this.forced;
      this.pending = false;
      this.forced = false;
      try {
        const changed = await this.changed();
        if (!this.stopped && (changed || force)) await this.observe();
      } catch (error) {
        // Preserve a focus check for the next request after a transient failure.
        this.forced ||= force;
        throw error;
      } finally {
        this.queued = false;
        // Yield between checks so user commands can advance through the queue.
        this.enqueue();
      }
    });
  }
}
