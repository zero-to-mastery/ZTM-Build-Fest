// Kitchen display mode (#669: #670, #671, ADR 0022 §4). State stays on the
// element (`this.app`); app/context.js explains the controllers.
//
// Identity and lock (the decision this story records):
// - It is a mode of an Adult's device, not a member kind. The device stays
//   unlocked and signed in as that adult; display/schedule.js keeps the
//   choice on this device, for this household's vault only.
// - Entering swaps the workspace for <kin-kitchen-display> (like Simple
//   view's separate shell, app/simple.js) and locks navigation: every route
//   is the display, the header, navigation, Quick add, Search, shortcuts,
//   the palette, item details and shares are gone. What it never shows has
//   no panel: the adult's journal, Just for me, reminders, Search, admin
//   actions, Household settings, Chat composition. A child's reward is the
//   one setting it offers (#699): the chore chart's own kind 78 path, for
//   the Adult whose device it is, with Undo. Saving or removing one, and
//   Undo or Redo of one, first asks for the adult's passkey or password
//   (#705, confirmAdult), as leaving does: the display hangs in the
//   kitchen, so anyone there could otherwise change it. Ticking chores,
//   shopping and the fridge stay open to everyone.
// - Auto-lock doesn't apply while it is a display (session.js
//   scheduleAutoLock); leaving needs the adult's passkey or password,
//   checked on this device (display/leave.js), then Kin reloads into the
//   full layout (a refresh keeps Kin unlocked, #351). Locking by hand, or
//   closing the browser, still locks; unlocking opens the display again.
// - If the household switches "Kitchen display" off, or this member turns
//   out not to be an Adult, the display locks Kin rather than opening the
//   adult's full workspace to whoever is in the kitchen.
//
// Screen: Screen Wake Lock (wake-lock.js, asked again when the page shows),
// dimming on the night schedule, the photo frame (or a clock) after the
// quiet minutes, and a touch brings the panels back. Panels come from
// display/panels.js and leave with their household features.
import { PANELS, visiblePanels } from "../../display/panels.js";
import { displayOnFor, isNight, msUntilNextChange, readDisplaySettings, writeDisplaySettings } from "../../display/schedule.js";
import { IdleTimer } from "../../display/idle.js";
import { askAdult } from "../../display/leave.js";
import { askAdultDialog } from "../display/leave-dialog.js";
import { KinKitchenDisplay } from "../kin-kitchen-display.js";
import { ScreenWake } from "../../wake-lock.js";
import { EventStore } from "../../storage/event-store.js";
import { addDays, weekAnchor } from "../../calendar/calendar-time.js";

const CLOCK_MS = 15_000;
// Events from the reused components that would open something the display
// doesn't have (an editor, item details, an import).
const CONTAINED = ["kin:calendar-open-event", "kin:calendar-new-event", "kin:calendar-import", "kin:open-item", "kin:open-help"];

export class DisplayController {
  constructor(ctx) {
    this.ctx = ctx;
    this.app = ctx.app;
    this.wake = null;
    this.idle = null;
    this.clockTimer = null;
    this.nightTimer = null;
    this.nightWoken = false;
    this.weekView = { view: "week", focus: null };
    this.onActivity = (event) => this.activity(event);
    // How confirmAdult reads this device's unlock manifest and shows the
    // dialog; a test replaces them.
    this.adultCheck = { readManifest: () => EventStore.securityStatus(), dialog: askAdultDialog };
    this.reset();
  }

  /** Whether this device is showing the kitchen display now. */
  get on() {
    return this.app.displayMode === true;
  }

  get settings() {
    return readDisplaySettings();
  }

  /** Whether this member may make this device a display: an Adult (the
   * service's kind, or the only person of a household that doesn't sync),
   * with the household's "Kitchen display" on and Simple view off. */
  available() {
    return this.ctx.chores.memberKind === "adult" && this.ctx.features.isOn("display") && !this.app.simpleView &&
      Boolean(this.app.vault && !this.app.vault.locked);
  }

  /** Household › Overview's setup section. */
  renderSetup() {
    const setup = this.app.displaySetup;
    if (!setup) return;
    setup.settings = this.settings;
    setup.available = this.available();
  }

  // ---- Entering and leaving ---------------------------------------------

  /** At unlock, after features are known: open the display again if this
   * device is one for this vault. */
  restore(vault) {
    if (this.on || this.app.simpleView || !displayOnFor(this.settings, vault?.vaultId)) return;
    if (!this.ctx.features.isOn("display")) { this.forget(); return; }
    this.enter();
  }

  /** "Use this device as a kitchen display" (kin:display-enter). */
  start({ night, idleMinutes } = {}) {
    if (this.on) return false;
    if (!this.available()) {
      this.ctx.status.setStatus("Only an adult's device can be a kitchen display.");
      return false;
    }
    const kept = writeDisplaySettings({ vaultId: this.app.vault.vaultId, on: true, night, idleMinutes });
    this.enter();
    this.ctx.status.setStatus(kept ? "This device is a kitchen display now." : "This device is a kitchen display until Kin locks: it couldn't keep the setting.");
    return true;
  }

  enter() {
    if (this.on || !this.app.main) return;
    this.app.displayMode = true;
    document.documentElement.dataset.kinDisplay = "on";
    // Whatever was open from the full layout closes.
    this.ctx.detail.closeItemDetail?.({ restoreFocus: false });
    this.app.commandPalette?.dismiss?.();
    for (const dialog of this.app.querySelectorAll("dialog[open]")) dialog.close();
    this.app.chatShare?.reset?.();
    this.ctx.attachments?.closeViewer?.();
    this.app.shoppingMode?.close?.();
    this.app.quickAdd.hidden = true;
    this.app.searchLink.hidden = true;
    for (const link of this.app.navLinks.values()) link.hidden = true;

    const display = document.createElement("kin-kitchen-display");
    this.app.kitchenDisplay = display;
    display.addEventListener("kin:display-leave", (event) => void this.leave({ opener: event.detail?.opener ?? null }));
    display.addEventListener("kin:display-help", (event) => this.ctx.help.open({ topic: "dialog:kitchen-display", opener: event.detail?.opener ?? null }));
    for (const type of CONTAINED) display.addEventListener(type, (event) => { event.stopPropagation(); event.preventDefault?.(); });
    display.addEventListener("kin:photo-frame-exit", () => this.wakeAll());
    display.addEventListener("click", (event) => {
      if (event.target.closest?.(".display-dimmer, .display-screensaver")) { event.stopPropagation(); this.wakeAll(); }
    });
    display.addEventListener("kin:display-shopping-tick", (event) => void this.tickShopping(event.detail));
    display.addEventListener("kin:display-shopping-add", (event) => void this.addShopping(event.detail));

    // The panels' elements: Today's events and the meals are the full
    // layout's own (their controllers keep them current); the week, the
    // chart, the shopping list and the messages are the display's.
    const week = document.createElement("kin-calendar");
    week.setAttribute("views", "day week");
    week.setAttribute("compact", "");
    week.setAttribute("readonly", "");
    week.addEventListener("kin:calendar-focus", (event) => {
      event.stopPropagation();
      this.weekView = { view: event.detail?.view ?? "week", focus: event.detail?.focus ?? null };
      void this.readWeek();
    });
    const chart = this.ctx.views.choreChartElement();
    chart.setAttribute("size", "display");
    // The fridge keeps its room and access rules; only its layout is the
    // display's (#700). Put back when the display goes (reset).
    this.app.fridge?.setAttribute("size", "display");
    this.app.choreJoin = null;
    this.elements = new Map([
      ["today", this.app.calendarToday],
      ["week", week],
      ["meals", this.app.tonight],
      ["chat", document.createElement("kin-display-chat")],
      ["chores", chart],
      ["shopping", document.createElement("kin-display-shopping")],
      ["fridge", this.app.fridge],
    ]);

    const section = document.createElement("section");
    section.className = "app-view display-view";
    section.id = "today";
    section.dataset.page = "today";
    section.setAttribute("aria-labelledby", "display-title");
    section.append(display);
    // The household panel stays connected, hidden, so this device still
    // learns of its own removal and locks; Chat stays too, for its room.
    const background = document.createElement("div");
    background.hidden = true;
    background.className = "display-background";
    if (this.app.household) background.append(this.app.household);
    if (this.app.chat) background.append(this.app.chat);
    this.app.controlFieldset.replaceChildren(section, background);
    this.app.pages = new Map([["today", section]]);
    this.app.segmentNavs = new Map();
    this.app.segmentPanels = new Map();
    this.layout();
    this.ctx.navigation.showPageFromLocation();

    // The screen: awake, the clock, the night, the quiet timer.
    this.wake = new ScreenWake();
    void this.wake.keepOn();
    this.clockTimer = setInterval(() => this.tick(), CLOCK_MS);
    const settings = this.settings;
    this.idle = new IdleTimer({ minutes: settings.idleMinutes, onIdle: () => this.goIdle(), onActive: () => this.wakeUp() });
    this.idle.start();
    this.nightWoken = false;
    this.followNight();
    for (const type of ["pointerdown", "keydown", "wheel"]) document.addEventListener(type, this.onActivity, { capture: true, passive: true });
    this.ctx.session.scheduleAutoLock();
    this.refresh();
  }

  /** The adult whose device it is confirms `purpose` ("leave", or
   * "reward" for a child's reward, #705) with their passkey or password,
   * checked on this device (display/leave.js askAdult). Resolves true once
   * confirmed; false when cancelled, refused, not a display, or while
   * another check's dialog is open (a double press).
   *
   * `asking` holds this check's token while its dialog is open and is
   * released synchronously as the dialog closes (the dialog's onSettle),
   * not after the promise chain unwinds: a press on Leave, Save reward or
   * Undo straight after a cancel opens a new dialog rather than being
   * ignored, as leaving did before it shared this check. `onSettle(value)`
   * is passed on for the caller to release its own guard the same way. */
  async confirmAdult(purpose, { onSettle = null } = {}) {
    if (!this.on || this.asking) return false;
    const token = { purpose };
    this.asking = token;
    const release = () => { if (this.asking === token) this.asking = null; };
    try {
      const confirmed = await askAdult(purpose, {
        readManifest: this.adultCheck.readManifest,
        vaultId: this.app.vault?.vaultId ?? null,
        ask: (options) => this.adultCheck.dialog({ ...options, host: this.app, onSettle: (value) => { release(); onSettle?.(value); } }),
      });
      return confirmed && this.on;
    } finally {
      // A dialog that never settled (it threw), or a stand-in without
      // onSettle; never another check's token.
      release();
    }
  }

  /** "Leave display mode": the adult's passkey or password, then the full
   * layout. Resolves whether it left. */
  async leave({ opener = null } = {}) {
    if (!this.on || this.asking) return false;
    const left = await this.confirmAdult("leave");
    if (!left || !this.on) { opener?.focus?.(); return false; }
    this.forget();
    this.ctx.status.setStatus("Leaving display mode…");
    this.reload();
    return true;
  }

  /** Back to the full layout: rebuilt cleanly by reloading; a refresh keeps
   * Kin unlocked (#351). */
  reload() {
    location.reload();
  }

  /** This device is no longer a display (for any household). */
  forget() {
    const settings = this.settings;
    writeDisplaySettings({ ...settings, on: false });
  }

  /** The household switched it off, or this member isn't an Adult: lock,
   * so nobody in the kitchen gets the adult's full Kin. */
  stopLocked(message) {
    this.forget();
    this.ctx.session.lockHousehold();
    this.ctx.status.setStatus(message);
  }

  /** On lock: everything about the display stops; the views are rebuilt. */
  reset() {
    this.idle?.stop();
    this.idle = null;
    void this.wake?.release();
    this.wake = null;
    clearInterval(this.clockTimer);
    this.clockTimer = null;
    clearTimeout(this.nightTimer);
    this.nightTimer = null;
    this.frame?.stop?.();
    this.frame = null;
    this.elements = null;
    this.weekView = { view: "week", focus: null };
    this.asking = null;
    if (typeof document !== "undefined") {
      for (const type of ["pointerdown", "keydown", "wheel"]) document.removeEventListener(type, this.onActivity, { capture: true });
      delete document.documentElement.dataset.kinDisplay;
      delete document.documentElement.dataset.kinDisplayNight;
    }
    if (!this.on) return;
    this.app.fridge?.removeAttribute("size");
    this.app.displayMode = false;
    this.app.kitchenDisplay = null;
    this.app.quickAdd.hidden = false;
    this.app.searchLink.hidden = false;
    for (const link of this.app.navLinks.values()) link.hidden = false;
  }

  // ---- Panels -----------------------------------------------------------

  /** The panels this household has on, placed by their regions. */
  visible() {
    const unavailable = [];
    if (this.app.chatAccess === "none" || this.app.chat?.room?.access === "none") unavailable.push("chat");
    if (this.app.fridge?.room?.access === "none") unavailable.push("fridge");
    return visiblePanels(PANELS, { isOn: (id) => this.ctx.features.isOn(id), unavailable });
  }

  layout() {
    const display = this.app.kitchenDisplay;
    if (!this.on || !display || !this.elements) return;
    display.place(this.visible().map((panel) => ({ panel, element: this.elements.get(panel.id) })).filter((entry) => entry.element));
  }

  /** After every render: the panels the display draws itself. */
  refresh() {
    if (!this.on || !this.elements || !this.app.state) return;
    this.layout();
    const shopping = this.elements.get("shopping");
    // Not disabled while saving: a render mid-save would leave it so. A
    // tick or add while Kin is busy is told to try again (chores.run).
    if (shopping) shopping.items = this.app.state.items;
    const chat = this.elements.get("chat");
    if (chat) chat.room = this.ctx.features.isOn("chat") ? this.app.chat?.room ?? null : null;
    if (this.app.kitchenDisplay) this.app.kitchenDisplay.offline = this.app.offline === true || navigator.onLine === false;
    void this.ctx.chores.refresh();
    void this.readWeek();
  }

  /** The week strip (or the day chosen in it), from the calendar. */
  async readWeek() {
    const week = this.elements?.get("week");
    if (!week || !this.ctx.features.isOn("calendar") || !this.app.store) return;
    const today = this.ctx.calendar.today();
    const { view } = this.weekView;
    const focus = this.weekView.focus ?? today;
    const from = view === "day" ? focus : weekAnchor(focus, today);
    const to = view === "day" ? focus : addDays(from, 6);
    try {
      const { days, extras } = await this.ctx.calendar.read(from, to);
      if (this.elements?.get("week") !== week) return;
      week.update({ view, focus, today, days, extras, people: this.ctx.calendar.people(), loading: false });
    } catch { /* keeps what it shows: offline, the last known state */ }
  }

  /** A shopping row ticked: the ordinary complete command. */
  async tickShopping({ itemId, text } = {}) {
    if (!itemId) return;
    const result = await this.ctx.chores.run({ type: "complete", itemId }, `Ticked “${text}”.`);
    if (!result.ok) this.refresh();
  }

  /** Something added to Shopping from the display. */
  async addShopping({ text, done } = {}) {
    // One plain add command: a half-saved capture from the full layout
    // (Quick add's pending draft) must not hold the display's box up.
    const id = crypto.randomUUID().replaceAll("-", "");
    const result = await this.ctx.chores.run({ type: "add", id, text, classification: "shopping" }, `Added “${text}” to Shopping.`);
    done?.(result.ok === true);
    this.refresh();
  }

  // ---- The screen -------------------------------------------------------

  tick() {
    this.app.kitchenDisplay?.setClock(new Date());
  }

  /** Dims at night unless someone woke it; follows the schedule with one
   * timer to the next start or end. */
  followNight() {
    clearTimeout(this.nightTimer);
    this.nightTimer = null;
    if (!this.on) return;
    const night = this.settings.night;
    const now = new Date();
    const dark = isNight(now.getHours() * 60 + now.getMinutes(), night);
    if (!dark) this.nightWoken = false;
    this.applyNight(dark && !this.nightWoken);
    const wait = msUntilNextChange(now, night);
    if (wait !== null) this.nightTimer = setTimeout(() => { this.nightWoken = false; this.followNight(); }, wait);
  }

  applyNight(dim) {
    const display = this.app.kitchenDisplay;
    if (!display) return;
    display.night = dim;
    if (dim) {
      document.documentElement.dataset.kinDisplayNight = "on";
      // The photo frame doesn't play in the dark.
      this.showScreensaver(false);
    } else delete document.documentElement.dataset.kinDisplayNight;
  }

  get dark() {
    const now = new Date();
    return isNight(now.getHours() * 60 + now.getMinutes(), this.settings.night);
  }

  /** A touch, a key or a tap anywhere. While the dimmer or the
   * screensaver covers the panels, a touch only wakes the screen: its
   * click lands on the cover (wakeAll), never on a panel beneath. */
  activity(event = null) {
    if (!this.on) return;
    const display = this.app.kitchenDisplay;
    if ((display?.night || display?.screensaver) && event?.type === "pointerdown") return;
    this.wakeAll();
  }

  wakeAll() {
    if (!this.on) return;
    if (this.app.kitchenDisplay?.night) {
      this.nightWoken = true;
      this.applyNight(false);
    }
    this.idle?.poke();
    this.showScreensaver(false);
  }

  /** Quiet for the chosen minutes: the photo frame, or at night the dimmer. */
  goIdle() {
    if (!this.on) return;
    if (this.dark) {
      this.nightWoken = false;
      this.applyNight(true);
      return;
    }
    this.showScreensaver(true);
  }

  wakeUp() {
    this.showScreensaver(false);
  }

  /** The screensaver: Family photos in <kin-photo-frame> (#673) when the
   * household has photos and the feature on, otherwise a calm clock. */
  showScreensaver(show) {
    const display = this.app.kitchenDisplay;
    if (!display) return;
    if (!show) {
      this.frame?.stop?.();
      this.frame = null;
      display.screensaver = null;
      return;
    }
    if (display.screensaver) return;
    const clock = () => {
      const element = KinKitchenDisplay.clock(new Date());
      display.screensaver = element;
      element.focus({ preventScroll: true });
    };
    if (!this.ctx.features.isOn("photos") || !customElements.get("kin-photo-frame") || !this.ctx.album) { clock(); return; }
    clock();
    void (async () => {
      try { await this.ctx.album.refresh({ force: true }); } catch { return; }
      if (!display.screensaver || display.screensaver.tagName === "KIN-PHOTO-FRAME") return;
      const photos = this.ctx.album.view().photos;
      if (!photos.length) return;
      const frame = document.createElement("kin-photo-frame");
      frame.setAttribute("aria-label", "Family photos. Touch the screen to see today.");
      frame.source = { photos, load: async (photo, { signal } = {}) => (await this.ctx.album.load(photo, { signal })).blob };
      this.frame = frame;
      display.screensaver = frame;
      frame.start();
      frame.focus({ preventScroll: true });
    })();
  }

  // ---- What the rest of the app tells it ---------------------------------

  /** A new household status (member kind, features): an Adult no longer,
   * and the display locks. */
  statusChanged() {
    this.renderSetup();
    const kind = this.app.householdStatus?.memberKind;
    if (this.on && kind && kind !== "adult") this.stopLocked("This device is no longer a kitchen display: only an adult's device can be one. Unlock to continue.");
  }

  /** The household's features changed. */
  featuresChanged() {
    this.renderSetup();
    if (!this.on) return;
    if (!this.ctx.features.isOn("display")) {
      this.stopLocked("Your household turned off the kitchen display, so Kin locked. Unlock to use this device as usual.");
      return;
    }
    this.layout();
  }

  /** The night hours `{ from, to }` (kept on this device), applied now. */
  setNight(night) {
    writeDisplaySettings({ ...this.settings, night });
    this.nightWoken = false;
    this.followNight();
  }

  /** The photo frame's wait, in minutes (kept on this device). */
  setIdleMinutes(minutes) {
    const settings = this.settings;
    writeDisplaySettings({ ...settings, idleMinutes: minutes });
    this.idle?.setMinutes(this.settings.idleMinutes);
  }
}
