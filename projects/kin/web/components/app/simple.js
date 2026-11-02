// Simple view (#345, #346, ADR 0013): when a household admin has turned it
// on for this device's Limited member, the unlocked workspace becomes a calm
// layout — Today's big cards, Chat and the Fridge — and nothing else is
// mounted. It is a layout, not a lock: the service enforces only the switch
// and Chat and Fridge access (ADR 0013).
//
// - restore() reads the cached layout at unlock, before the workspace shows,
//   so an offline unlock opens the same view as last time.
// - setSimpleView() takes the service's value from each sync pass. Turning
//   it on applies at once; turning it off reloads Kin into the full layout
//   (a refresh keeps Kin unlocked where that setting is on).
// - refresh() runs after every render: Rust's "my things today", item emoji
//   and tonight's dinner become the cards.
// - markDone() / undo use the ordinary item and routine commands.
import { loadCachedSimpleView } from "../../sync/sync-coordinator.js";
import { resolveSimpleRoute, routeHash, SIMPLE_ROUTES } from "../../routes.js";
import { buildCards } from "../../simple/simple-view.js";
import { tonightLine } from "../../meals/meals-view.js";
import { syncProgress } from "./feedback.js";
import { SAVE_ERROR } from "./constants.js";

export class SimpleController {
  constructor(ctx) {
    this.ctx = ctx;
    this.app = ctx.app;
    this.loading = null;
    this.again = false;
    this.doneThisSession = new Map();
  }

  /** Whether Simple view is applied in this session. */
  get on() {
    return this.app.simpleView === true;
  }

  /** At unlock: apply the cached layout before the workspace shows. */
  async restore(identity, session) {
    if (!identity) return;
    let cached = false;
    try { cached = await loadCachedSimpleView(identity); } catch { cached = false; }
    if (!this.ctx.session.isCurrentSession(session)) return;
    if (cached) this.enter();
  }

  /** The service's value for this member, from a sync pass. `cached` says
   * whether this device saved it for the next unlock. */
  setSimpleView(on, { cached = true } = {}) {
    if (on === this.on) return;
    if (on) {
      this.enter();
      this.ctx.render.renderState();
      this.ctx.status.setStatus("Your household turned on Simple view for you.");
      return;
    }
    // Back to the full layout: rebuild it cleanly by reloading — but only
    // once the cache says so, or the next unlock would come back here.
    if (!cached) {
      this.ctx.status.setStatus("Your household turned off Simple view. Lock and unlock Kin to see everything.");
      return;
    }
    this.ctx.status.setStatus("Your household turned off Simple view. Opening the full Kin…");
    this.reload();
  }

  reload() {
    location.reload();
  }

  /** What this member may reach: Chat and the Fridge once their rooms are
   * open, unless access is none. Without a room (offline, before sync) the
   * page couldn't work anyway, so it isn't offered. */
  access() {
    const open = (room) => Boolean(room) && room.access !== "none";
    // A household that switched Chat or the Fridge off (#625) has neither.
    const on = (id) => this.ctx.features?.isOn(id) !== false;
    // The chore chart (#676) needs nothing from the service; it leaves with
    // its feature.
    return { chat: on("chat") && open(this.app.chat?.room), fridge: on("fridge") && open(this.app.fridge?.room), chores: on("chores") };
  }

  /** Mounts the Simple view workspace: Today's cards, Chat, the Fridge. */
  enter() {
    if (this.on || !this.app.main) return;
    this.app.simpleView = true;
    document.documentElement.dataset.kinSimple = "on";
    // Simple view wins over easy mode (ADR 0021): the stricter layout.
    delete document.documentElement.dataset.kinEasy;
    this.app.removeAttribute("data-easy");
    // Off in Simple view: Quick add, Search, the palette and shortcuts
    // (navigation.js), bulk selection and item details (detail.js).
    this.app.quickAdd.hidden = true;
    this.app.searchLink.hidden = true;
    this.ctx.detail.closeItemDetail?.({ restoreFocus: false });
    // Anything open from the full layout closes (switching on mid-session).
    this.app.commandPalette?.dismiss?.();
    for (const dialog of this.app.querySelectorAll("dialog[open]")) dialog.close();
    this.app.chatShare?.reset?.();
    this.ctx.attachments?.closeViewer?.();
    this.app.chat && (this.app.chat.simple = true);
    // Navigation: Today, Chat and Fridge only, relabelled.
    for (const [id, link] of this.app.navLinks) {
      const simple = id === "today" ? SIMPLE_ROUTES.today : id === "updates" ? SIMPLE_ROUTES.chat : id === "household" ? SIMPLE_ROUTES.fridge : null;
      link.hidden = !simple;
      if (!simple) continue;
      link.dataset.fullHref ??= link.getAttribute("href");
      link.dataset.fullLabel ??= link.querySelector("span")?.textContent ?? "";
      link.setAttribute("href", routeHash(simple.page, simple.segment ?? null));
      const label = link.querySelector("span");
      if (label) label.textContent = simple.label;
    }
    // The workspace: only these three pages are mounted.
    const page = (id, title, ...children) => {
      const section = document.createElement("section");
      section.className = "app-view simple-view";
      section.id = id;
      section.dataset.page = id;
      section.setAttribute("aria-labelledby", `${id}-title`);
      const heading = document.createElement("h1");
      heading.id = `${id}-title`;
      heading.tabIndex = -1;
      heading.textContent = title;
      // Help on every screen (#621), Simple view's included.
      section.append(heading, this.ctx.help.button(), ...children);
      return section;
    };
    this.app.simpleToday = document.createElement("kin-simple");
    this.app.simpleToday.previews = this.app.previewProvider;
    // The chore chart (#676): one big link from Today to the child's chart,
    // with the same chart the full layout shows (Join and rewards aren't
    // offered here).
    this.app.simpleChoresLink = document.createElement("a");
    this.app.simpleChoresLink.className = "simple-chores-link";
    this.app.simpleChoresLink.href = routeHash(SIMPLE_ROUTES.chores.page);
    this.app.simpleChoresLink.textContent = "My chore chart";
    const today = page("today", "Today", this.app.simpleChoresLink, this.app.simpleToday);
    const chat = page("updates", "Chat", this.app.chat);
    const fridge = page("household", "Fridge", this.app.fridge);
    const back = document.createElement("a");
    back.className = "simple-back-link";
    back.href = routeHash("today");
    back.textContent = "Back to Today";
    const chores = page("chores", "Chore chart", this.ctx.views.choreChartElement(), back);
    this.app.choreJoin = null;
    // The household element stays connected, hidden, so this device still
    // learns of its own removal and locks (checkHouseholdAuthorization).
    const background = document.createElement("div");
    background.hidden = true;
    background.className = "simple-background";
    if (this.app.household) background.append(this.app.household);
    this.app.simpleBackground = background;
    this.app.controlFieldset.replaceChildren(today, chat, fridge, chores, background);
    this.app.pages = new Map([["today", today], ["updates", chat], ["household", fridge], ["chores", chores]]);
    this.app.segmentNavs = new Map();
    this.app.segmentPanels = new Map();
    this.updateAccess();
    this.ctx.navigation.showPageFromLocation();
  }

  /** Hides Chat or the Fridge from the navigation when access is none. */
  updateAccess() {
    if (!this.on) return;
    const { chat, fridge, chores } = this.access();
    this.app.navLinks.get("updates").hidden = !chat;
    this.app.navLinks.get("household").hidden = !fridge;
    this.app.nav.classList.toggle("simple-nav-single", !chat && !fridge);
    if (this.app.simpleChoresLink) this.app.simpleChoresLink.hidden = !chores;
    // A page that is no longer allowed goes back to Today.
    const route = this.app.route;
    if (route && ((route.page === "updates" && !chat) || (route.page === "household" && !fridge) || (route.page === "chores" && !chores))) this.ctx.navigation.navigate("#today");
  }

  /** The route Simple view allows for the current location. */
  route(location) {
    return resolveSimpleRoute(location, this.access());
  }

  /** On lock: forget this session's Simple view and put the shell back. */
  reset() {
    this.doneThisSession = new Map();
    this.app.itemEmojis = null;
    this.again = false;
    if (!this.on) return;
    this.app.simpleView = false;
    delete document.documentElement.dataset.kinSimple;
    this.app.quickAdd.hidden = false;
    this.app.searchLink.hidden = false;
    this.app.nav.classList.remove("simple-nav-single");
    for (const link of this.app.navLinks.values()) {
      link.hidden = false;
      if (link.dataset.fullHref) link.setAttribute("href", link.dataset.fullHref);
      const label = link.querySelector("span");
      if (label && link.dataset.fullLabel) label.textContent = link.dataset.fullLabel;
      delete link.dataset.fullHref;
      delete link.dataset.fullLabel;
    }
    this.app.simpleToday = null;
    this.app.simpleBackground = null;
    this.app.simpleChoresLink = null;
    if (this.app.chat) this.app.chat.simple = false;
  }

  /** Rebuilds the cards; safe to call after every render. */
  refresh() {
    if (!this.on) return Promise.resolve();
    if (this.loading) {
      this.again = true;
      return this.loading;
    }
    this.loading = this.load().finally(() => {
      this.loading = null;
      if (this.again) {
        this.again = false;
        void this.refresh();
      }
    });
    return this.loading;
  }

  async load() {
    const session = this.ctx.session.captureSession();
    const memberId = this.ctx.detail.responsibilityContext().memberId;
    if (!session.store || !memberId || !this.app.simpleToday) return;
    let things, emojis;
    try {
      things = await session.store.myThings(memberId);
      emojis = await session.store.itemEmojis();
    } catch {
      return;
    }
    if (!this.ctx.session.isCurrentSession(session) || !this.app.simpleToday) return;
    this.app.simpleToday.cards = buildCards(things, { state: this.app.state, emojis, rows: this.app.attachmentRows, doneThisSession: this.doneThisSession });
    const today = this.ctx.meals?.today?.();
    const dinner = today ? this.app.mealsState?.dinners.find((entry) => entry.date === today) ?? null : null;
    this.app.simpleToday.tonight = this.ctx.features?.isOn("meals") === false ? null : tonightLine(dinner, this.ctx.meals?.people?.() ?? {});
    this.updateAccess();
  }

  /** Every item's picture emoji (#347), for rows and details; one shared
   * Map, replaced only when an emoji changed. Calls coalesce. */
  refreshPictures() {
    if (this.loadingPictures) { this.picturesAgain = true; return this.loadingPictures; }
    this.loadingPictures = this.loadPictures().finally(() => {
      this.loadingPictures = null;
      if (this.picturesAgain) { this.picturesAgain = false; void this.refreshPictures(); }
    });
    return this.loadingPictures;
  }

  async loadPictures() {
    const session = this.ctx.session.captureSession();
    if (!session.store) return;
    let emojis;
    try { emojis = await session.store.itemEmojis(); } catch { return; }
    if (!this.ctx.session.isCurrentSession(session)) return;
    const previous = this.app.itemEmojis;
    if (previous && previous.size === emojis.size && [...emojis].every(([id, emoji]) => previous.get(id) === emoji)) return;
    this.app.itemEmojis = emojis;
    for (const list of [this.app.today, this.app.needs, this.app.shopping, this.app.staples]) if (list) list.emojis = emojis;
    if (this.app.selection) this.ctx.detail.feedDetail();
  }

  /** Sets or clears an item's picture emoji (#347). */
  async setItemEmoji({ itemId, emoji = null }) {
    if (!this.app.store || !this.app.engine) return false;
    if (this.app.busy) { this.ctx.status.setStatus("Kin is still saving. Try again in a moment."); return false; }
    const session = this.ctx.session.captureSession();
    this.ctx.status.setBusy(true);
    this.ctx.status.clearAlert();
    try {
      await this.ctx.append.appendCommand({ type: "set-item-emoji", itemId, emoji });
      this.ctx.session.assertCurrentSession(session);
      this.ctx.render.renderState();
      await this.refreshPictures();
      const progress = syncProgress({ syncing: Boolean(this.app.syncCoordinator), offline: navigator.onLine === false });
      this.ctx.status.setStatus(`${emoji ? "Picture saved." : "Picture removed."}${progress}`);
      this.ctx.peers.broadcastEventChange();
      return true;
    } catch (error) {
      if (error.code === "locked" || !this.ctx.session.isCurrentSession(session)) return false;
      this.ctx.status.setStatus("");
      // Rust refuses anything but one emoji, and an unchanged picture.
      this.ctx.status.showAlert(error.code === 4 || error.code === 2 ? (emoji ? "Choose one emoji for the picture." : "This item has no picture.") : (error.userMessage ?? SAVE_ERROR),
        error.code === 4 || error.code === 2 ? null : () => this.setItemEmoji({ itemId, emoji }));
      return false;
    } finally {
      if (this.ctx.session.isCurrentSession(session)) {
        this.ctx.status.setBusy(false);
        this.ctx.peers.flushPeerRefresh();
      }
    }
  }

  /** Done (or Undo) for one card, through the ordinary commands. */
  async markDone({ key, kind, id, text, occurrenceKey, undo }) {
    if (!this.app.store || !this.app.engine) return false;
    if (this.app.busy) { this.ctx.status.setStatus("Kin is still saving. Try again in a moment."); return false; }
    const command = kind === "item"
      ? { type: undo ? "reopen" : "complete", itemId: id }
      : { type: undo ? "reopen-routine-occurrence" : "complete-routine-occurrence", routineId: id, occurrenceKey };
    const session = this.ctx.session.captureSession();
    // Keep the card in its place, with Undo, for this session.
    const index = this.app.simpleToday ? [...this.app.simpleToday.querySelectorAll(".simple-card")].findIndex((card) => card.dataset.key === key) : -1;
    this.ctx.status.setBusy(true);
    this.ctx.status.clearAlert();
    try {
      await this.ctx.append.appendCommand(command);
      this.ctx.session.assertCurrentSession(session);
      if (kind === "item") {
        if (undo) this.doneThisSession.delete(key);
        else this.doneThisSession.set(key, { id, index: Math.max(0, index) });
      }
      this.ctx.render.renderState();
      await this.refresh();
      const progress = syncProgress({ syncing: Boolean(this.app.syncCoordinator), offline: navigator.onLine === false });
      this.ctx.status.setStatus(`${undo ? `Marked “${text}” not done.` : `Marked “${text}” done.`}${progress}`);
      this.ctx.peers.broadcastEventChange();
      return true;
    } catch (error) {
      if (error.code === "locked" || !this.ctx.session.isCurrentSession(session)) return false;
      if (error.code === 4) this.app.pendingRefresh = true;
      this.ctx.status.setStatus("");
      this.ctx.status.showAlert(error.userMessage ?? SAVE_ERROR, () => this.markDone({ key, kind, id, text, occurrenceKey, undo }));
      return false;
    } finally {
      if (this.ctx.session.isCurrentSession(session)) {
        this.ctx.status.setBusy(false);
        this.ctx.peers.flushPeerRefresh();
      }
    }
  }
}
