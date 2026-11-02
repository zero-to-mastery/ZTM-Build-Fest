// The kitchen display's quiet timer (#671): after `minutes` without a touch,
// key or tap, `onIdle()` runs (the photo frame shows); the next touch runs
// `onActive()` (back to the panels). Timers are injected so tests can drive
// them. No DOM.

export class IdleTimer {
  // The defaults are wrapped: a browser's setTimeout and clearTimeout throw
  // "Illegal invocation" when called as another object's methods.
  constructor({ minutes, onIdle = () => {}, onActive = () => {}, setTimer = (fn, delay) => globalThis.setTimeout(fn, delay), clearTimer = (id) => globalThis.clearTimeout(id), now = () => Date.now() } = {}) {
    this.minutes = minutes;
    this.onIdle = onIdle;
    this.onActive = onActive;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.now = now;
    this.timer = null;
    this.idle = false;
    this.running = false;
    this.lastActivity = null;
  }

  get period() {
    return Math.max(1, Number(this.minutes) || 1) * 60_000;
  }

  /** Starts watching, as if just touched. */
  start() {
    this.running = true;
    this.idle = false;
    this.poke();
  }

  /** A touch, key or tap. Ends an idle spell (onActive) and starts the
   * quiet period again. Returns whether it ended one. */
  poke() {
    if (!this.running) return false;
    this.lastActivity = this.now();
    const ended = this.idle;
    this.idle = false;
    this.arm(this.period);
    if (ended) this.onActive();
    return ended;
  }

  /** A new quiet period, from now. */
  setMinutes(minutes) {
    this.minutes = minutes;
    if (this.running && !this.idle) this.arm(this.period);
  }

  /** Goes idle now (a test, or "Show photos"). */
  sleep() {
    if (!this.running || this.idle) return;
    this.clearTimer(this.timer);
    this.timer = null;
    this.idle = true;
    this.onIdle();
  }

  arm(delay) {
    this.clearTimer(this.timer);
    this.timer = this.setTimer(() => {
      this.timer = null;
      if (!this.running) return;
      // A timer that fired early (a clock change) waits out the rest.
      const left = this.lastActivity + this.period - this.now();
      if (left > 1000) { this.arm(left); return; }
      this.idle = true;
      this.onIdle();
    }, delay);
  }

  stop() {
    this.running = false;
    this.idle = false;
    this.clearTimer(this.timer);
    this.timer = null;
  }
}
