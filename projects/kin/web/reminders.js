// Browser-local, foreground reminder timers. These are intentionally
// ephemeral: the browser may suspend timers or terminate the page, so this is
// not a scheduler. Lock suspends them: timers stop and titles are dropped,
// keeping only { id, at, vaultId } in memory until the same vault unlocks
// again. With private storage on, the reminders themselves live in the
// member's private log (#522) and app/private-prefs.js arms these timers from
// it on every device that allows notifications.
export class LocalReminders {
  // Browser timer functions must be called with the global as `this`; storing
  // them as instance methods and calling `this.setTimer(...)` would throw
  // "Illegal invocation", so the defaults are wrapped.
  constructor({ notification = globalThis.Notification, setTimer = (...args) => globalThis.setTimeout(...args), clearTimer = (...args) => globalThis.clearTimeout(...args), now = () => Date.now() } = {}) {
    this.notification = notification;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.now = now;
    this.entries = new Map();
    this.suspended = new Map();
  }

  // `token` identifies this attempt, so a caller can later cancel only the
  // reminder it created and never a newer one for the same id.
  async schedule({ id, title, at, isCurrent = () => true, token = null }) {
    if (typeof id !== "string" || !id || !Number.isFinite(at) || at <= this.now()) throw new Error("Choose a future reminder time.");
    if (!this.notification) return "unsupported";
    let permission = this.notification.permission;
    if (permission === "default") permission = await this.notification.requestPermission();
    if (permission !== "granted") return permission === "denied" ? "denied" : "unsupported";
    // The prompt can outlast the session; never arm a title it no longer owns.
    if (!isCurrent()) return "stale";
    this.arm({ id, title, at, isCurrent, token });
    return "granted";
  }

  // Delivers once at `at`, or on the next task when `at` has already passed.
  // `onShown(notification)` hears about the notification once it is shown.
  arm({ id, title, at, isCurrent, token = null, onShown = null }) {
    this.cancel(id);
    this.suspended.delete(id);
    const entry = { at, timer: null, token };
    const tick = () => {
      if (this.entries.get(id) !== entry) return;
      const remaining = at - this.now();
      if (remaining > 0) { entry.timer = this.setTimer(tick, Math.min(remaining, 2_147_000_000)); return; }
      this.entries.delete(id);
      let shown = null;
      try { if (isCurrent()) shown = new this.notification(title, { body: "A household reminder you asked for.", tag: `kin-${id}` }); } catch { /* Permission or browser state may change before delivery. */ }
      if (shown && onShown) try { onShown(shown); } catch { /* the reminder was still delivered */ }
    };
    entry.timer = this.setTimer(tick, Math.max(0, Math.min(at - this.now(), 2_147_000_000)));
    this.entries.set(id, entry);
  }

  // With a token, cancels only the attempt that token created.
  cancel(id, token) {
    const entry = this.entries.get(id);
    if (!entry || (token !== undefined && entry.token !== token)) return false;
    this.clearTimer(entry.timer);
    this.entries.delete(id);
    return true;
  }

  // Lock: stop every timer and keep no title or closure, only when each
  // reminder was due and which vault it belongs to.
  suspendAll(vaultId) {
    for (const [id, entry] of this.entries) {
      this.clearTimer(entry.timer);
      this.suspended.set(id, { id, at: entry.at, vaultId });
    }
    this.entries.clear();
  }

  // Unlock: re-arm the same vault's reminders from fresh records. `lookup(id)`
  // returns { title, isCurrent } for a live record, or null to drop it.
  // Never prompts; without granted permission they stay suspended.
  resumeAll(vaultId, lookup) {
    for (const [id, entry] of this.suspended) {
      if (entry.vaultId !== vaultId) { this.suspended.delete(id); continue; }
      if (this.notification?.permission !== "granted") continue;
      const target = lookup(id);
      this.suspended.delete(id);
      if (target) this.arm({ id, title: target.title, at: entry.at, isCurrent: target.isCurrent });
    }
  }

  // Logout, leaving or deleting the household, restore: reminders end for good.
  clearAll() {
    for (const id of [...this.entries.keys()]) this.cancel(id);
    this.suspended.clear();
  }
}
