// Rendering the projection into the views.
// State stays on the element (`this.app`); app/context.js explains the controllers.
import { routeHash, SEGMENTS } from "../../routes.js";
import { recordDiagnostic } from "../../diagnostics/ring-buffer.js";
import { errorName } from "../../diagnostics/global.js";
import { formatCivilDate } from "../../today-view.js";
import { DESTINATION_DESCRIPTIONS } from "./constants.js";
import { searchableHousehold } from "../../features.js";

const NO_ROUTINES = Object.freeze([]);

export class RenderController {
  constructor(ctx) {
    this.ctx = ctx;
    this.app = ctx.app;
  }

  /** The Updates segments: handoffs waiting, and Chat's unread count (#133),
   * which comes from the chat view and never leaves this device. */
  renderUpdatesNav(waiting = (this.app.state?.handoffs ?? []).filter((record) => record.status === "unacknowledged").length) {
    // The page's plain description names Chat only while this member has it
    // and the household has it on (#625).
    const chat = this.app.chatAccess !== "none" && this.ctx.features.isOn("chat");
    if (this.app.updatesLead)
      this.app.updatesLead.textContent = !chat
        ? DESTINATION_DESCRIPTIONS.updatesWithoutChat
        : DESTINATION_DESCRIPTIONS.updates;
    const updatesNav = this.app.segmentNavs?.get("updates");
    if (!updatesNav) return;
    const unread = this.app.chatUnread ?? { count: 0, mentions: 0, capped: false };
    updatesNav.segments = SEGMENTS.updates.filter((entry) => !(entry.id === "chat" && !chat)).map((entry) => {
      const base = { id: entry.id, label: entry.label, hash: routeHash("updates", entry.id) };
      if (entry.id === "chat") {
        // An "@" marks unread messages that mention this member (#130).
        const number = unread.capped || unread.count > 99 ? "99+" : String(unread.count);
        const mentioned = (unread.mentions ?? 0) > 0;
        return { ...base, count: unread.count, countText: mentioned ? `@ ${number}` : number, countLabel: "unread", ...(mentioned ? { countAria: `${number} unread, includes mentions of you` } : {}) };
      }
      return { ...base, count: entry.id === "handoffs" ? waiting : 0, countLabel: "waiting" };
    });
    if (this.app.route?.page === "updates") updatesNav.current = this.app.route.segment;
  }

  renderState() {
    if (!this.app.vault || this.app.vault.locked || !this.app.state) return;
    // Rendering reconciles the whole unlocked workspace and is also used for
    // background sync. Suppress motion during that pass; navigation and
    // explicitly opened detail sheets keep their separate entrance effects.
    const renderToken = (this.app.quietRenderToken ?? 0) + 1;
    this.app.quietRenderToken = renderToken;
    this.app.setAttribute("data-quiet-render", "");
    const started = performance.now();
    try {
      this.renderStateContents();
    } catch (error) {
      recordDiagnostic("render_failed", { component: "workspace", name: errorName(error) });
      throw error;
    } finally {
      // A slow whole-workspace render is worth knowing about (#631).
      const ms = performance.now() - started;
      if (ms > 250) recordDiagnostic("render_slow", { component: "workspace", ms });
      const clearQuietRender = () => {
        if (this.app.quietRenderToken === renderToken) this.app.removeAttribute("data-quiet-render");
      };
      if (typeof globalThis.requestAnimationFrame === "function") globalThis.requestAnimationFrame(clearQuietRender);
      else setTimeout(clearQuietRender, 0);
    }
  }
  // Views receive the projection's arrays as they are; an unchanged section is
  // the same array as last time, so the views skip it (COMPONENTS.md,
  // "Incremental rendering"). The `?? []` fallbacks only matter for fields the
  // decoder omits when empty (attachments, responsibilities); the decoder
  // always provides the others.
  renderStateContents() {
    const mode = this.app.state.mode ?? "normal";
    this.app.modeSelect.value = mode;
    this.app.routines.householdMode = mode;
    const civilDate = this.ctx.navigation.currentCivilDate();
    const responsibilityContext = this.ctx.detail.responsibilityContext();
    this.app.catchUp.summary = this.app.state.summary;
    // Meals replay from history on their own; the read coalesces.
    void this.ctx.meals?.refresh();
    // Simple view's cards (#345) read the same history.
    void this.ctx.simple?.refresh();
    // Item picture emoji (#347) for the rows and details.
    void this.ctx.simple?.refreshPictures();
    this.app.catchUp.lastLookedAt = this.app.catchUpCursor?.lastLookedAt;
    this.app.todayDate.textContent = formatCivilDate(civilDate);
    const selected = this.app.selection?.itemId ?? null;
    for (const list of [this.app.needs, this.app.shopping, this.app.staples]) {
      list.update({
        today: civilDate,
        items: this.app.state.items,
        responsibilityContext,
        areas: this.app.state.areas ?? [],
        pins: this.app.state.pins ?? [],
        attachments: this.app.attachmentRows,
        selected,
        emojis: this.app.itemEmojis ?? null,
      });
    }
    if (this.app.shoppingMode) this.app.shoppingMode.items = this.app.state.items;
    // This week (#416) reads from Rust while it's showing; the calendar
    // (#660) reads Today's events and the view on screen.
    void this.ctx.week?.refresh();
    void this.ctx.calendar?.refresh();
    // The chore chart (#676) likewise.
    void this.ctx.chores?.refresh();
    // The kitchen display's own panels (#671).
    this.ctx.display?.refresh();
    // The sitter page (#441) while its editor or For you is showing.
    void this.ctx.sitter?.refresh();
    // Family photos (#673) while the page or its slideshow is showing.
    void this.ctx.album?.refresh();
    // Taking turns (#437): whose turn it is, from Rust, after each render.
    void this.ctx.rotations?.refresh();
    // Store sections (#411) read from Rust after each render.
    void this.ctx.sections?.refresh();
    this.app.today.update({
      today: civilDate,
      items: this.app.state.items,
      responsibilityContext,
      areas: this.app.state.areas ?? [],
      pins: this.app.state.pins ?? [],
      attachments: this.app.attachmentRows,
      selected,
      // Routines switched off (#625) leave Today; their history stays.
      routines: this.ctx.features.isOn("routines") ? this.app.state.routines ?? [] : NO_ROUTINES,
      handoffs: this.app.state.handoffs ?? [],
      mode,
      emojis: this.app.itemEmojis ?? null,
    });
    const waiting = (this.app.state.handoffs ?? []).filter((record) => record.status === "unacknowledged").length;
    const updatesNav = this.app.segmentNavs?.get("updates");
    this.renderUpdatesNav(waiting);
    if (updatesNav && this.app.route?.page === "updates") updatesNav.current = this.app.route.segment;
    const activePulse = this.app.state.pulses.find((pulse) => pulse.actorId === this.app.store?.actorId && pulse.status === "active");
    if (this.app.householdGlance) this.app.householdGlance.textContent = `Household mode: ${{ normal: "Normal", vacation: "Vacation", guests: "Guests", rest: "Rest" }[mode] ?? mode}${mode !== "normal" ? " (routines paused)" : ""}. Your pulse: ${activePulse ? activePulse.value.replace("-", " ") : "not set"}.`;
    if (this.app.selection) {
      const current = this.app.state.items.find((item) => item.itemId === this.app.selection.itemId) ?? null;
      this.ctx.detail.feedDetail(current);
    }
    this.ctx.records.renderReminders();
    this.app.handoffs.handoffs = this.app.state.handoffs;
    this.app.talks.talks = this.app.state.talks;
    // The Chat toolbar's To talk about count includes older open topics.
    this.app.chat.legacyOpenCount = this.app.state.talks.filter((record) => record.status === "open").length;
    // Search leaves out what switched-off features hold (#625).
    this.app.search.household = searchableHousehold({
      items: this.app.state.items,
      handoffs: this.app.state.handoffs,
      talks: this.app.state.talks,
      notes: this.app.state.notes ?? [],
      referenceRecords: this.app.state.referenceRecords ?? [],
      maintenanceEvents: this.app.state.maintenanceEvents ?? [],
      areas: this.app.state.areas ?? [],
    }, this.ctx.features.off);
    this.app.pulse.pulse = this.app.state.pulses.find(
      (pulse) => pulse.actorId === this.app.store?.actorId,
    );
    this.app.routines.today = civilDate;
    this.app.routines.routines = this.app.state.routines ?? [];
    this.app.routines.responsibilityContext = responsibilityContext;
    this.app.routines.playbooks = this.app.state.playbooks ?? [];
    this.app.areas.areas = this.app.state.areas ?? [];
    this.app.notes.notes = this.app.state.notes ?? [];
    this.app.notes.references = this.app.state.referenceRecords ?? [];
    this.app.notes.maintenance = this.app.state.maintenanceEvents ?? [];
    this.app.notes.attachments = this.app.attachmentRows;
    this.app.notes.routines = this.app.state.routines ?? [];
    this.app.notes.areas = this.app.state.areas ?? [];
    this.ctx.status.updateOnboardingDensity();
    this.updateCalendarExportButton();
    this.ctx.refresh.schedulePulseRefresh();
    // The app icon count (#476) follows every change: sync, completion, adds.
    this.ctx.badge?.update();
  }
  updateCalendarExportButton() {
    if (!this.app.calendarExportButton) return;
    this.app.calendarExportButton.disabled = this.app.busy || !this.app.state?.items?.some(
      (item) => item.status === "active" && item.planningDate != null,
    );
  }
}
