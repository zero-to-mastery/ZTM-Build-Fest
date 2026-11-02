// Blob URLs for decrypted attachments that were opened or downloaded. Each one
// expires on its own timer, and lock revokes all of them at once, so a lock
// leaves no decrypted attachment reachable from this page by URL. Content
// already showing in another tab is that tab's to close; Kin cannot reach it.
export class ObjectUrlRegistry {
  // The default timers are wrappers: a browser's setTimeout refuses to run
  // with this registry as its receiver ("Illegal invocation").
  constructor({ lifetimeMs = 60_000, url = URL, setTimer = (callback, ms) => setTimeout(callback, ms), clearTimer = (id) => clearTimeout(id) } = {}) {
    this.lifetimeMs = lifetimeMs;
    this.url = url;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.timers = new Map();
  }

  /** A blob URL for `blob` that is revoked after the lifetime or on revokeAll(). */
  create(blob) {
    const url = this.url.createObjectURL(blob);
    this.timers.set(url, this.setTimer(() => this.revoke(url), this.lifetimeMs));
    return url;
  }

  revoke(url) {
    if (!this.timers.has(url)) return;
    this.clearTimer(this.timers.get(url));
    this.timers.delete(url);
    this.url.revokeObjectURL(url);
  }

  revokeAll() {
    for (const url of [...this.timers.keys()]) this.revoke(url);
  }

  get size() {
    return this.timers.size;
  }
}
