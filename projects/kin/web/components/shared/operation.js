// One guarded asynchronous operation at a time for a component: the host gets
// aria-busy while it runs, run() refuses to start a second one meanwhile, and
// cancel() (on lock) makes the running one stale so its late result and any
// failure are ignored.
export class OperationGuard {
  constructor(host, { onBusy = () => {}, onError = () => {}, canStart = () => true } = {}) {
    this.host = host;
    this.onBusy = onBusy;
    this.onError = onError;
    this.canStart = canStart;
    this.current = 0;
    this.busy = false;
  }

  /** Runs `action(operation)` unless one is already running or the host cannot start. */
  async run(action) {
    if (this.busy || !this.canStart()) return;
    const operation = ++this.current;
    this.setBusy(true);
    try {
      await action(operation);
    } catch (error) {
      if (operation === this.current) await this.onError(error, operation);
    } finally {
      if (operation === this.current) this.setBusy(false);
    }
  }

  isCurrent(operation) {
    return operation === this.current;
  }

  assertCurrent(operation, message = "This operation was cancelled.") {
    if (operation !== this.current) throw new Error(message);
  }

  /** Makes every in-flight operation stale and clears busy. */
  cancel() {
    this.current += 1;
    if (this.busy) this.setBusy(false);
  }

  setBusy(value) {
    this.busy = value;
    this.host.setAttribute("aria-busy", String(value));
    this.onBusy(value);
  }
}
