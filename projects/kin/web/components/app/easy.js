// Easy mode (#616, #617, ADR 0021): bigger text and buttons, a word on every
// icon, and fewer things on screen, for anyone who wants Kin calmer. A
// presentation the member chooses, not a lock; Simple view wins when both
// are on.
// State stays on the element (`this.app`); app/context.js explains the controllers.
//
// - The setting is `easy-mode` (key 8) in the member's synced settings, kept
//   on this device as `kin.easy-mode` (appearance/display-prefs.js) like
//   text size, so the lock screen opens the same way. app/private-prefs.js
//   applies it; the document root then carries `data-kin-easy="on"` and
//   <kin-app> `data-easy`, which app.css reads.
// - apply() runs after every change of the setting: it marks <kin-app> and
//   updates the navigation and Today's tip.
// - routeShown() runs on every page change: it remembers the place (route
//   names only, easy/easy-mode.js) and marks the navigation links and tabs
//   easy mode tucks away (`data-easy-hidden`; app.css hides them only in
//   easy mode, so the regular layout is untouched).
import { EASY_MODE_KEY, readDisplayPref } from "../../appearance/display-prefs.js";
import { easyNavigation, noteVisit, readRecent, writeRecent } from "../../easy/easy-mode.js";
import { SEGMENTS } from "../../routes.js";

export class EasyController {
  constructor(ctx) {
    this.ctx = ctx;
    this.app = ctx.app;
  }

  /** Whether easy mode shows now (on, and Simple view off). */
  get on() {
    return document.documentElement.dataset.kinEasy === "on";
  }

  /** Whether the member chose it (even while Simple view overrides it). */
  get chosen() {
    return readDisplayPref(EASY_MODE_KEY) === "on";
  }

  /** Turns easy mode on or off from Kin's own controls (Today's offer);
   * Identity & appearance uses the same setting. */
  set(on) {
    return this.ctx.privatePrefs.setDisplaySetting("easy-mode", on ? "on" : "off");
  }

  apply() {
    this.app.toggleAttribute("data-easy", this.on);
    this.updateNavigation();
    this.ctx.help?.renderTip();
  }

  routeShown(route) {
    if (route?.canonical) writeRecent(noteVisit(readRecent(), route.canonical, Date.now()));
    this.updateNavigation();
  }

  updateNavigation() {
    const route = this.app.route ?? null;
    const { pages, segments } = easyNavigation(readRecent(), Date.now(), route ? { page: route.page, segment: route.segment } : null);
    if (route?.destination) pages.add(route.destination);
    // A household feature an admin switched off (ADR 0021 §2) stays out of
    // easy mode's navigation too, whatever was used before.
    const available = (target) => this.ctx.features?.routeAvailable?.(target) !== false;
    for (const [id, link] of this.app.navLinks ?? []) link.toggleAttribute("data-easy-hidden", !pages.has(id) || !available(id));
    for (const [page, nav] of this.app.segmentNavs ?? []) {
      const kept = segments[page] ?? new Set();
      nav.easyHidden = (SEGMENTS[page] ?? []).filter((entry) => !kept.has(entry.id) || !available(`${page}/${entry.id}`)).map((entry) => entry.id);
    }
  }
}
