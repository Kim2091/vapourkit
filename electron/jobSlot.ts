/**
 * Holds the one running job of a kind (an upscale, a graph probe, a preview
 * session) and owns how it is stopped.
 *
 * A handler that awaits after starting a job checks `holds(job)` afterwards:
 * a cancel, or a newer job of the same kind, may have replaced it meanwhile.
 */
export class JobSlot<T, Reason = void> {
  private job: T | null = null;

  constructor(private readonly stopJob: (job: T, reason: Reason) => void) {}

  get current(): T | null {
    return this.job;
  }

  /** Stops the job in the slot, if any, and puts `job` in its place. */
  start(job: T, reason: Reason): T {
    this.stop(reason);
    this.job = job;
    return job;
  }

  /** Stops the job in the slot and empties it. Returns whether one was running. */
  stop(reason: Reason): boolean {
    const job = this.job;
    if (job === null) return false;
    this.job = null;
    this.stopJob(job, reason);
    return true;
  }

  /** Empties the slot without stopping its job, if it still holds `job`. */
  release(job: T): void {
    if (this.job === job) this.job = null;
  }

  holds(job: T): boolean {
    return this.job === job;
  }
}
