// Routes, keyboard shortcuts and search-result navigation.
// State stays on the element (`this.app`); app/context.js explains the controllers.
import { projectionContext } from "../../browser-time.js";
import { recordDiagnostic } from "../../diagnostics/ring-buffer.js";
import { errorName } from "../../diagnostics/global.js";
import { listSegmentForClassification, resolveRoute, ROUTE_CHANGE_EVENT, routeHash } from "../../routes.js";
import { isTypingContext, shortcutForKey } from "../../keyboard-commands.js";
import { firstAvailableSegment, unavailableLine } from "../../features.js";

export class NavigationController {
  constructor(ctx) {
    this.ctx = ctx;
    this.app = ctx.app;
  }

  /** The route for a location; Simple view allows only its pages (#345). */
  routeFor(where) {
    // The kitchen display (#670) is one page: every route is it.
    if (this.app.displayMode) return resolveRoute({ hash: "#today" });
    return this.app.simpleView ? this.ctx.simple.route(where) : resolveRoute(where);
  }

  navigate(hash) {
    const route = this.routeFor({ hash, pathname: location.pathname });
    // An old Talk link becomes Chat's address; the list still opens.
    if (route.topics) this.pendingTopics = true;
    if (location.hash !== route.hash) history.pushState(null, "", route.hash);
    this.ctx.navigation.showPageFromLocation();
  }
  showPageFromLocation() {
    // A failure here is noted in the diagnostic ring buffer (#631), as the
    // page's route name and the error's kind only.
    try { return this.showRoute(); } catch (error) {
      recordDiagnostic("route_failed", { page: this.app.route?.page, name: errorName(error) });
      throw error;
    }
  }
  showRoute() {
    if (!this.app.pages || !this.app.navLinks) return;
    let route = this.routeFor({ hash: location.hash, pathname: location.pathname });
    // A switched-off feature (#625, ADR 0021): its routes, links and
    // shortcuts open Today with a calm line. Simple view has its own list.
    if (!this.app.simpleView && !this.app.displayMode && !this.ctx.features.routeAvailable(route)) {
      // The Calendar's views are one page (#661): a switched-off view (the
      // Week view with only the Calendar on) opens the first one that is
      // on. Other pages' segments are places of their own and open Today.
      const segment = route.page === "week" ? firstAvailableSegment(route.page, this.ctx.features.off) : null;
      if (segment) {
        route = resolveRoute({ hash: routeHash(route.page, segment) });
      } else {
        const blocked = this.ctx.features.blocking(route);
        route = resolveRoute({ hash: "#today" });
        this.ctx.status.setStatus(unavailableLine(blocked));
      }
      history.replaceState(null, "", route.hash);
    }
    // Old Talk links with Talk later off open Chat without its list.
    if (route.topics && !this.ctx.features.isOn("talk")) {
      route = { ...route };
      delete route.topics;
      this.pendingTopics = false;
    }
    // Without chat access (#123) Chat isn't there: its links, and the old
    // Talk tab's, go to Handoffs, where the older topics then live (#312).
    if (route.page === "updates" && route.segment === "chat" && this.app.chatAccess === "none" && !this.app.simpleView) {
      route = { ...resolveRoute({ hash: routeHash("updates", "handoffs") }), ...(route.topics ? { topics: true } : {}) };
      history.replaceState(null, "", route.hash);
    } else if (route.topics) {
      history.replaceState(null, "", route.hash);
    }
    // Simple view keeps the address on an allowed page.
    if ((this.app.simpleView || this.app.displayMode) && location.hash !== route.hash) history.replaceState(null, "", route.hash);
    const previous = this.app.route ?? null;
    const changed = previous?.canonical !== route.canonical;
    if (previous && changed) this.app.pageScroll.set(previous.canonical, window.scrollY);
    this.app.route = route;
    this.app.activePage = route.page;
    this.app.dataset.route = route.canonical;
    document.title = this.app.vault && !this.app.vault.locked && this.app.householdName ? `${this.app.householdName} — Kin` : `${route.title} — Kin`;
    if (changed && this.app.routeAnnouncement) this.app.routeAnnouncement.textContent = `${route.title} view`;
    if (changed && previous) window.dispatchEvent(new CustomEvent(ROUTE_CHANGE_EVENT, { detail: { from: previous.canonical, to: route.canonical } }));
    for (const [id, section] of this.app.pages) section.hidden = id !== route.page;
    for (const [id, link] of this.app.navLinks) {
      if (id === route.destination) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    }
    for (const [pageId, nav] of this.app.segmentNavs) if (pageId === route.page) nav.current = route.segment;
    for (const [pageId, panels] of this.app.segmentPanels) {
      if (pageId !== route.page) continue;
      for (const [segment, panel] of panels) panel.hidden = segment !== route.segment;
    }
    // Easy mode remembers the place and trims the navigation; Help puts
    // away a highlight left on another page and shows Today's tip (#617, #622).
    this.ctx.easy?.routeShown(route);
    this.ctx.help?.routeShown(route);
    if (route.page === "routines") this.app.routines.view = route.segment;
    // The Calendar (#661): its view is the route's segment.
    if (route.page === "week") {
      this.ctx.calendar?.routeShown(route);
      void this.ctx.week?.refresh();
    }
    if (route.page === "chores" || route.page === "routines") void this.ctx.chores?.refresh();
    void this.ctx.sitter?.refresh();
    void this.ctx.album?.refresh();
    // Details stay open only within the page that opened them.
    if (this.app.selection && this.app.selection.page !== route.page) this.ctx.detail.closeItemDetail({ restoreFocus: false });
    this.ctx.detail.mountDetail();
    if (route.topics || this.pendingTopics) {
      this.pendingTopics = false;
      this.revealTopics();
    }
    if (changed && previous) {
      const remembered = this.app.pageScroll.get(route.canonical) ?? 0;
      requestAnimationFrame(() => window.scrollTo({ top: remembered, behavior: "auto" }));
      if (route.page === "search") this.app.search.focusInput?.();
    }
  }
  /** The To talk about list (#312): Chat's panel, or the Handoffs section
   * without chat access. */
  revealTopics() {
    if (this.app.chatAccess === "none") {
      const section = this.app.talksStandalone;
      requestAnimationFrame(() => { section?.scrollIntoView({ block: "start" }); section?.querySelector("h2")?.setAttribute("tabindex", "-1"); section?.querySelector("h2")?.focus({ preventScroll: true }); });
      return;
    }
    this.app.chat?.openTopics?.();
  }
  // Shortcuts and palette commands act only on an unlocked, rendered
  // workspace; the security screen and its fields never see them.
  workspaceReady() {
    return Boolean(this.app.vault && !this.app.vault.locked && this.app.store && this.app.main && !this.app.main.hidden &&
      this.app.siteTools && !this.app.siteTools.hidden && this.app.commandPalette?.isConnected);
  }
  handleShortcutKeydown(event) {
    // Simple view has no keyboard shortcuts or command palette (#345).
    if (event.defaultPrevented || this.app.simpleView || this.app.displayMode || !this.ctx.navigation.workspaceReady()) return;
    const shortcut = shortcutForKey(event, { mac: this.app.macShortcuts });
    if (!shortcut) return;
    const openDialogs = [...this.app.querySelectorAll("dialog[open]")];
    let active = document.activeElement;
    while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
    const opener = active && active !== document.body && active !== document.documentElement ? active : null;
    if (shortcut === "palette") {
      // Another app dialog (Quick add, item details, the photo viewer) keeps
      // its keyboard; the browser keeps Ctrl/Cmd+K there too.
      if (openDialogs.some((dialog) => !this.app.commandPalette.contains(dialog))) return;
      event.preventDefault();
      if (!this.app.commandPalette.isOpen) this.app.commandGeneration = this.app.securityGeneration;
      this.app.commandPalette.openPalette({ opener });
      return;
    }
    if (openDialogs.length || isTypingContext(event, active)) return;
    event.preventDefault();
    if (shortcut === "undo" || shortcut === "redo") { void this.ctx.undo.run(shortcut); return; }
    this.ctx.append.runWorkspaceCommand(shortcut, { opener });
  }
  layoutMode() {
    if (this.app.phoneQuery?.matches) return "sheet";
    if (this.app.wideQuery?.matches) return "side";
    return "inline";
  }
  // Search results open the real record by canonical id.
  /** A chat message picked on the Search page (#124): open Chat and show it. */
  handleOpenChatMessage(detail) {
    if (!this.app.state || !this.app.chat?.room) return;
    this.ctx.navigation.navigate(routeHash("updates", "chat"));
    requestAnimationFrame(() => requestAnimationFrame(() => {
      void this.app.chat.showSearchResult(detail);
    }));
  }

  handleOpenSearchResult(detail) {
    if (!this.app.state) return;
    const unavailable = () => this.ctx.status.setStatus("That record is no longer available. It may have been archived or removed.");
    const reveal = (hash, selector) => {
      this.ctx.navigation.navigate(hash);
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const target = this.app.main.querySelector(selector);
        if (!target) { unavailable(); return; }
        target.scrollIntoView({ block: "center" });
        target.classList.add("record-highlight");
        setTimeout(() => target.classList.remove("record-highlight"), 2_500);
        (target.matches("button, input, select, textarea, [tabindex]") ? target : target.querySelector("button, [tabindex]") ?? target).focus();
      }));
    };
    switch (detail.kind) {
      case "item":
      case "step": {
        const itemId = detail.kind === "step" ? detail.itemId : detail.id;
        const item = this.app.state.items.find((record) => record.itemId === itemId && record.status !== "archived");
        if (!item) { unavailable(); return; }
        this.ctx.navigation.navigate(routeHash("lists", listSegmentForClassification(item.classification)));
        this.ctx.detail.openItemDetail(itemId, { opener: detail.opener, stepId: detail.kind === "step" ? detail.stepId : null, origin: "search" });
        this.app.selection.originId = detail.id;
        return;
      }
      case "handoff":
        if (!this.app.state.handoffs.some((record) => record.handoffId === detail.id && record.status !== "archived")) { unavailable(); return; }
        reveal(routeHash("updates", "handoffs"), `[data-handoff-id="${detail.id}"]`);
        return;
      case "talk":
        if (!this.app.state.talks.some((record) => record.talkId === detail.id && record.status !== "archived")) { unavailable(); return; }
        reveal("#updates/talk", `[data-talk-id="${detail.id}"]`);
        return;
      case "note":
        if (!(this.app.state.notes ?? []).some((record) => record.noteId === detail.id && !record.archived)) { unavailable(); return; }
        reveal(routeHash("household", "notes"), `[data-note-id="${detail.id}"]`);
        return;
      case "reference-record":
        if (!(this.app.state.referenceRecords ?? []).some((record) => record.recordId === detail.id && !record.archived)) { unavailable(); return; }
        reveal(routeHash("household", "notes"), `[data-record-id="${detail.id}"]`);
        return;
      case "maintenance":
        if (!(this.app.state.maintenanceEvents ?? []).some((record) => record.maintenanceId === detail.id && !record.archived)) { unavailable(); return; }
        reveal(routeHash("household", "notes"), `[data-maintenance-id="${detail.id}"]`);
        return;
      default:
        unavailable();
    }
  }
  currentCivilDate() { return projectionContext().civilDate; }
}
