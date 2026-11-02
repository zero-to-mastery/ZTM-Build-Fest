// Reminders and settings that follow the member (#520, ADR 0019): the
// member's private log holds them; this controller keeps this device in step.
// State stays on the element (`this.app`); app/context.js explains the
// controllers.
//
// - attach(log) when sync opens the member's private log (sync.js
//   onPrivateLog); detach() when it closes (lock, sign-out, sync stopped).
//   Without a private log — a member set up the old way (passkey and backup
//   key, no account), Temporary members, or Limited members while the
//   household turned private storage off — reminders and settings stay on
//   this device exactly as before, and the settings say so in one line.
// - Each change to the log (this device's or another's) reconciles:
//   1. Reminders this device set before private storage was on move into
//      the log once (synced-prefs.js migrationPlan; a thing that already has
//      a synced reminder keeps it, and Rust refuses a set that changes
//      nothing, so nothing is duplicated however often this runs).
//   2. Unless this device uses its own settings, synced settings apply here,
//      and on the first pass this device's non-default ones seed keys
//      nothing has synced yet.
//   3. Synced reminders are armed here when reminder alerts are on and this
//      browser allows notifications; ones cleared or moved elsewhere are
//      disarmed and their notifications closed.
// - Setting, canceling, finishing (item done, routine archived) and
//   dismissing (closing or clicking the notification) write to the log, so
//   every device follows.
import { DEVICE_ONLY_KEY, DISPLAY_SETTING_KEYS, EASY_MODE_KEY, MOTION_KEY, REMINDER_ALERTS_KEY, TEXT_SIZE_KEY, applyDisplayPrefs, readDisplayPref, writeDisplayPref } from "../../appearance/display-prefs.js";
import { saveAppearance } from "../../appearance/store.js";
import { resolveAppearance } from "../../appearance/household.js";
import { appearanceSettings, applyAppearanceSettings, changedSettings, describeSyncedReminder, migrationPlan, reminderPlan, settingsPlan, zoneSnapshot } from "../../private/synced-prefs.js";

export class PrivatePrefsController {
  constructor(ctx) {
    this.ctx = ctx;
    this.app = ctx.app;
    this.log = null;
    this.session = null;
    this.unsubscribe = null;
    this.projection = null;
    this.visible = new Map();
    // Timers this device armed from the log: { id → { at } }. Kept across a
    // lock of the same vault (LocalReminders suspends and resumes them) so
    // they are never mistaken for this device's own reminders to move in.
    this.armedFromSync = new Map();
    // "id@at" this device already showed, and the notifications it shows.
    this.fired = new Set();
    this.shown = new Map();
    this.seeded = false;
    this.work = Promise.resolve();
    this.queued = false;
  }

  /** Whether reminders and settings follow the member from this device:
   * private storage is on and the member key is here. */
  get active() {
    return Boolean(this.log?.active) && this.current();
  }

  /** Whether they can: also while the member has no key yet, which the
   * first private change makes (ADR 0019: the member key is made on first
   * use; a device that opened before another made it adopts it, private-log.js
   * ensureKeys). */
  get available() {
    return this.active || (this.log?.reason === "no_member_key" && this.current());
  }

  /** Whether this device keeps its own settings ("Use different settings on
   * this device"). Reminders follow the member either way. */
  get deviceOnly() {
    return readDisplayPref(DEVICE_ONLY_KEY) === "on";
  }

  /** What the settings say about where they live: "synced", "device-only",
   * "off" (the household turned private storage off for this member), or
   * "device" (no private storage here: no account yet, or not ready). */
  get scope() {
    if (this.available) return this.deviceOnly ? "device-only" : "synced";
    if (this.log && this.log.reason === "off") return "off";
    return "device";
  }

  current() {
    return Boolean(this.session) && this.ctx.session.isCurrentSession(this.session);
  }

  attach(log, session = this.ctx.session.captureSession()) {
    this.detach({ render: false });
    this.log = log;
    this.session = session;
    this.seeded = false;
    this.unsubscribe = log.subscribe(() => void this.refresh());
    void this.refresh();
  }

  detach({ render = true } = {}) {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.log = null;
    this.projection = null;
    this.visible = new Map();
    if (render) this.render();
  }

  /** On sign-out, leaving or deleting the household and restore: nothing
   * armed or shown from the log survives. */
  forget() {
    this.detach();
    this.armedFromSync.clear();
    this.fired.clear();
    for (const { notification } of this.shown.values()) this.closeQuietly(notification);
    this.shown.clear();
  }

  /** Runs `task` after everything queued before it. */
  enqueue(task) {
    const run = this.work.then(task);
    this.work = run.catch(() => {});
    return run;
  }

  /** Reconciles once more after whatever is running (calls coalesce). */
  refresh() {
    if (this.queued) return this.work;
    this.queued = true;
    return this.enqueue(async () => {
      this.queued = false;
      await this.reconcile();
    }).catch(() => {});
  }

  /** One private change; a change Rust finds changes nothing (code 4) is
   * already so and is not an error. Resolves to whether it was written. */
  async tryChange(command) {
    const log = this.log;
    if (!log || !this.current()) return false;
    // The member's first private change makes the member key, or adopts the
    // one another device made (member-key.js create reads the vault first).
    if (!log.active && log.reason === "no_member_key") await log.enable();
    if (!log.active || !this.current()) return false;
    try {
      await log.execute(command);
      return true;
    } catch (error) {
      if (error?.code === 4) return false;
      throw error;
    }
  }

  /** tryChange for the reconcile pass: trouble writing one change (offline
   * storage, a full private log) never stops the rest of the pass. */
  async quietly(command) {
    try { return await this.tryChange(command); } catch { return false; }
  }

  async reconcile() {
    const log = this.log;
    if (log && this.current() && !log.active && log.reason === "no_member_key") {
      // No member key yet: nothing private to read. Make it only when this
      // device has something to bring (its own reminders, or settings it
      // changed); the pass after that moves them in.
      const own = [...this.app.localReminders.entries].filter(([id]) => !this.armedFromSync.has(id))
        .map(([id, entry]) => [id, { at: entry.at }]);
      const bringing = migrationPlan(new Map(own), [], Date.now()).length > 0 ||
        (!this.deviceOnly && this.app.personalAppearance && settingsPlan(this.localSettings(), {}).seed.length > 0);
      if (bringing) { try { await log.enable(); } catch { /* the next pass tries again */ } }
      this.render();
      return;
    }
    if (!log?.active || !this.current()) { this.render(); return; }
    let projection;
    try { projection = log.projection(); } catch { return; }
    if (log !== this.log || !this.current()) return;
    this.projection = projection;
    // 1. This device's own reminders move in once.
    const own = new Map([...this.app.localReminders.entries]
      .filter(([id]) => !this.armedFromSync.has(id))
      .map(([id, entry]) => [id, { at: entry.at }]));
    let wrote = false;
    for (const { reminderId, at } of migrationPlan(own, projection.reminders, Date.now())) {
      // The timer already armed for it is now the synced reminder's.
      this.armedFromSync.set(reminderId, { at });
      wrote = (await this.quietly({ type: "set-reminder", reminderId, at, ...zoneSnapshot(at) })) || wrote;
    }
    if (wrote) return; // the log changed: another pass follows.
    // 2. Settings, unless this device keeps its own.
    if (!this.deviceOnly) {
      const { apply, seed } = settingsPlan(this.localSettings(), projection.settings);
      try { await this.applySettings(apply); } catch { /* the next pass tries again */ }
      // Seeded once per attach, after this device's saved theme has loaded.
      if (!this.seeded && this.app.personalAppearance) {
        this.seeded = true;
        for (const { key, value } of seed) wrote = (await this.quietly({ type: "set-setting", key, value })) || wrote;
        if (wrote) return;
      }
    }
    // 3. Reminders.
    this.schedule(projection.reminders);
    this.render();
  }

  /** This device's values of the settings that follow the member. */
  localSettings() {
    const theme = this.app.personalAppearance ? appearanceSettings(this.app.personalAppearance) : {};
    const values = {
      "text-size": readDisplayPref(TEXT_SIZE_KEY),
      motion: readDisplayPref(MOTION_KEY),
      "reminder-alerts": readDisplayPref(REMINDER_ALERTS_KEY),
      "app-badge": this.ctx.badge.choice,
      "easy-mode": readDisplayPref(EASY_MODE_KEY),
    };
    for (const key of ["theme-mode", "theme-color"]) if (theme[key]) values[key] = theme[key];
    return values;
  }

  async applySettings(apply) {
    if (!Object.keys(apply).length) return;
    if (apply["theme-mode"] || apply["theme-color"]) await this.applyTheme(apply);
    if (apply["app-badge"]) {
      this.ctx.badge.setChoice(apply["app-badge"]);
      if (this.app.appBadge) this.app.appBadge.value = apply["app-badge"];
    }
    for (const [name, key] of Object.entries(DISPLAY_SETTING_KEYS)) {
      if (apply[name]) writeDisplayPref(key, apply[name]);
    }
    this.applyDisplay();
  }

  async applyTheme(apply) {
    const personal = this.app.personalAppearance;
    if (!personal || !this.app.store || !this.app.vault) return;
    const next = applyAppearanceSettings(personal, apply);
    if (!next) return;
    const session = this.session;
    const saved = await saveAppearance(this.app.store, this.app.vault, next);
    if (!this.ctx.session.isCurrentSession(session)) return;
    this.app.personalAppearance = structuredClone(saved);
    const effective = resolveAppearance(saved, this.app.householdSettings);
    // An open, changed appearance editor keeps the member's draft.
    if (!this.app.appearance?.dirty) this.app.appearance?.initialize(effective);
    this.ctx.appearance.applyAppearance(effective);
  }

  /** Puts this device's text size, motion and easy mode on the page. */
  applyDisplay() {
    applyDisplayPrefs({ textSize: readDisplayPref(TEXT_SIZE_KEY), motion: readDisplayPref(MOTION_KEY), easyMode: readDisplayPref(EASY_MODE_KEY) });
    this.ctx.easy?.apply();
    this.app.personalSettings?.update?.(this.settingsView());
  }

  /** The member changed `keys` on this device (the appearance editor, the
   * app icon count, <kin-personal-settings>): the log follows unless this
   * device keeps its own settings. */
  settingsChanged(keys) {
    if (!this.available || this.deviceOnly) return Promise.resolve();
    return this.enqueue(async () => {
      for (const { key, value } of changedSettings(this.localSettings(), this.projection?.settings ?? {}, keys))
        await this.tryChange({ type: "set-setting", key, value });
    }).catch(() => {
      if (this.current()) this.ctx.status.setStatus("Kin kept that setting on this device; your other devices will get it once private storage is reachable.");
    });
  }

  /** A choice on <kin-personal-settings>. */
  async setDisplaySetting(name, value) {
    const key = DISPLAY_SETTING_KEYS[name];
    if (!key) return;
    const kept = writeDisplayPref(key, value);
    this.applyDisplay();
    if (name === "reminder-alerts") void this.refresh();
    await this.settingsChanged([name]);
    return kept;
  }

  /** "Use different settings on this device". Turning it off follows the
   * member's settings again (theirs win; any this device has that nothing
   * synced yet go up). */
  setDeviceOnly(on) {
    const kept = writeDisplayPref(DEVICE_ONLY_KEY, on ? "on" : "off");
    if (!on) this.seeded = false;
    void this.refresh();
    this.render();
    return kept;
  }

  /** Arms, disarms and closes from the synced reminders. */
  schedule(reminders) {
    const Notification = this.app.localReminders.notification;
    const alerts = readDisplayPref(REMINDER_ALERTS_KEY) === "on" && Notification?.permission === "granted";
    const plan = reminderPlan(reminders, { now: Date.now(), armed: this.armedFromSync, fired: this.fired, alerts });
    for (const id of plan.cancel) {
      this.app.localReminders.cancel(id);
      this.armedFromSync.delete(id);
    }
    // A notification for a reminder cleared or moved on another device goes.
    const still = new Map(reminders.map((reminder) => [reminder.reminderId, reminder.at]));
    for (const [id, shown] of this.shown) {
      if (still.get(id) === shown.at) continue;
      this.shown.delete(id);
      this.closeQuietly(shown.notification);
    }
    for (const { reminderId: id, at } of plan.arm) {
      const target = this.ctx.records.reminderTarget(id, this.session);
      // Not here yet (the household change hasn't synced) or not live.
      if (!target) continue;
      this.app.localReminders.arm({ id, title: target.title, at, isCurrent: target.isCurrent, onShown: (notification) => this.shownReminder(id, at, notification) });
      this.armedFromSync.set(id, { at });
    }
    this.visible = plan.visible;
  }

  shownReminder(id, at, notification) {
    this.fired.add(`${id}@${at}`);
    this.shown.set(id, { at, notification });
    // Clicked or closed on one device: dealt with on every device. A click
    // dismisses by itself, since not every platform reports the close that
    // follows it.
    const dismiss = () => {
      if (this.shown.get(id)?.notification !== notification) return;
      this.shown.delete(id);
      void this.endReminder(id, "dismissed", at).catch(() => {});
    };
    notification.onclick = () => {
      try { globalThis.focus?.(); } catch { /* focus is a courtesy */ }
      dismiss();
      try { notification.close(); } catch { /* already gone */ }
    };
    notification.onclose = dismiss;
  }

  closeQuietly(notification) {
    try {
      notification.onclose = null;
      notification.onclick = null;
      notification.close();
    } catch { /* already gone */ }
  }

  /**
   * Sets a reminder (kin-reminder's "Set reminder"). With private storage
   * it is saved for all the member's devices, even where this browser
   * can't notify; without it, it is this device's only, as before. Resolves
   * to "granted", "denied", "unsupported" or "stale" (the record changed
   * while the browser asked for permission), and whether it was synced.
   */
  async setReminder({ id, title, at }) {
    if (!this.available) {
      const session = this.ctx.session.captureSession();
      const target = this.ctx.records.reminderTarget(id, session);
      const token = Symbol(id);
      const result = await this.app.localReminders.schedule({ id, title, at, isCurrent: target?.isCurrent ?? (() => false), token });
      if (!this.ctx.session.isCurrentSession(session)) { this.app.localReminders.cancel(id, token); return { result: "stale", synced: false }; }
      return { result, synced: false };
    }
    if (!Number.isFinite(at) || at <= Date.now()) throw new Error("Choose a future reminder time.");
    const session = this.session;
    const Notification = this.app.localReminders.notification;
    let permission = Notification ? Notification.permission : "unsupported";
    if (permission === "default") permission = await Notification.requestPermission();
    if (!this.ctx.session.isCurrentSession(session)) return { result: "stale", synced: false };
    if (!this.ctx.records.reminderTarget(id, session)) return { result: "stale", synced: false };
    await this.enqueue(() => this.tryChange({ type: "set-reminder", reminderId: id, at, ...zoneSnapshot(at) }));
    await this.refresh();
    return { result: permission === "granted" ? "granted" : permission === "denied" ? "denied" : "unsupported", synced: true };
  }

  /**
   * Ends a reminder: "canceled" (the member took it off, or its date or
   * schedule changed), "done" (the item completed or archived, the routine
   * archived or its occurrence done) or "dismissed" (its notification was
   * dealt with; `at` is the instant that fired). This device's timer stops
   * at once; with private storage, every device follows.
   */
  endReminder(id, reason, at = undefined) {
    if (reason !== "dismissed") this.app.localReminders.cancel(id);
    if (!this.available) return Promise.resolve(false);
    return this.enqueue(async () => {
      const synced = this.projection?.reminders.find((reminder) => reminder.reminderId === id);
      if (!synced) return false;
      return this.tryChange({ type: "clear-reminder", reminderId: id, reason, at: at ?? synced.at });
    });
  }

  /** Reminders to show beside their items and routines: { id → { at,
   * scope, where } }. */
  reminderView() {
    if (this.available) {
      return new Map([...this.visible].map(([id, reminder]) => [id, { at: reminder.at, scope: "devices", where: describeSyncedReminder(reminder).where }]));
    }
    return new Map([...this.app.localReminders.entries].map(([id, entry]) => [id, { at: entry.at, scope: "device", where: "" }]));
  }

  /** What <kin-personal-settings> shows. */
  settingsView() {
    return {
      scope: this.scope,
      textSize: readDisplayPref(TEXT_SIZE_KEY),
      motion: readDisplayPref(MOTION_KEY),
      reminderAlerts: readDisplayPref(REMINDER_ALERTS_KEY),
      easyMode: readDisplayPref(EASY_MODE_KEY),
      deviceOnly: this.deviceOnly,
    };
  }

  render() {
    this.app.personalSettings?.update?.(this.settingsView());
    this.ctx.records.renderReminders();
  }
}
