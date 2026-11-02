// Keeping the screen on while shopping (#408). A thin, testable wrapper over
// the Screen Wake Lock API: the browser releases a lock whenever the page is
// hidden, so it is asked for again when the page comes back, while wanted.
// Where the API is missing, `supported` is false and nothing happens.

export class ScreenWake {
  constructor({ wakeLock = globalThis.navigator?.wakeLock ?? null, doc = globalThis.document ?? null } = {}) {
    this.api = wakeLock;
    this.doc = doc;
    this.sentinel = null;
    this.wanted = false;
    this.onVisibility = () => {
      if (this.wanted && this.doc?.visibilityState === "visible" && !this.sentinel) void this.acquire();
    };
  }

  get supported() {
    return typeof this.api?.request === "function";
  }

  /** Whether the screen is being kept on right now. */
  get active() {
    return Boolean(this.sentinel && !this.sentinel.released);
  }

  async keepOn() {
    if (!this.supported) return false;
    this.wanted = true;
    this.doc?.addEventListener?.("visibilitychange", this.onVisibility);
    return this.acquire();
  }

  async acquire() {
    try {
      const sentinel = await this.api.request("screen");
      if (!this.wanted) {
        await sentinel.release();
        return false;
      }
      this.sentinel = sentinel;
      sentinel.addEventListener?.("release", () => { if (this.sentinel === sentinel) this.sentinel = null; });
      return true;
    } catch {
      // Refused (battery saver, page not visible): the list still works.
      this.sentinel = null;
      return false;
    }
  }

  async release() {
    this.wanted = false;
    this.doc?.removeEventListener?.("visibilitychange", this.onVisibility);
    const sentinel = this.sentinel;
    this.sentinel = null;
    try { await sentinel?.release(); } catch { /* already released */ }
  }
}
