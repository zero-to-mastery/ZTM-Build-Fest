// Household features (ADR 0021 §2, #625): which parts of Kin this household
// switched off, applied to this device's workspace. The set comes from the
// service on each status read (sync coordinator, household panel) and is
// kept on the device (features-cache.js), so an offline unlock hides the
// same things. A household that doesn't sync keeps its own set here.
//
// The generic hook for every destination is `routeAvailable(route)` (and
// `isOn(id)`): navigation, Help and the other surfaces ask it rather than
// knowing which feature owns what. Parts inside other pages carry
// `data-feature="<id>"` and app.css hides them; links into a whole page
// carry `data-feature-route="<route>"` and are marked here.
//
// State stays on the element (`this.app`); app/context.js explains the
// controllers.
import { COMMANDS } from "../../keyboard-commands.js";
import { routeHash, SEGMENTS } from "../../routes.js";
import {
  availableCommands, blockingFeature, featuresAttribute, hiddenChatActions, isFeatureOn, offFeatures,
  parseFeatureSet, routeAvailable, turnedOffNote,
} from "../../features.js";
import { readFeatureCache, writeFeatureCache } from "../../features-cache.js";

/** The document root's dataset, where app.css reads the switched-off ids;
 * null outside a browser. */
const rootDataset = () => globalThis.document?.documentElement?.dataset ?? null;

export class FeaturesController {
  constructor(ctx) {
    this.ctx = ctx;
    this.app = ctx.app;
    this.reset();
  }

  /** On lock and before an unlock: everything on, nothing known. */
  reset() {
    this.scope = null;
    this.off = 0;
    this.revision = 0;
    this.noticed = 0;
    this.admin = false;
    this.known = false;
    // Whether the service answered in this session: an admin changes the
    // set only once it has (offline, the page says to connect).
    this.heard = false;
    const root = rootDataset();
    if (root) delete root.kinFeaturesOff;
  }

  /** Whether feature `id` is on (an unknown id is always on). */
  isOn(id) {
    return isFeatureOn(this.off, id);
  }

  /** Whether a route ("week", "lists/meals" or a resolved route) is
   * available: the generic hook other destinations ask. */
  routeAvailable(route) {
    return routeAvailable(route, this.off);
  }

  /** The switched-off feature behind an unavailable route, or null. */
  blocking(route) {
    return blockingFeature(route, this.off);
  }

  /** Whether this household keeps its set on this device (it doesn't sync). */
  get local() {
    return this.scope === "local";
  }

  /** What the Features page shows: the set, its revision, who may change
   * it, and where it is saved. */
  get value() {
    return { off: this.off, revision: this.revision, admin: this.admin, local: this.local, heard: this.heard };
  }

  /** A page's segment links, without the segments of switched-off features. */
  segmentEntries(pageId) {
    return (SEGMENTS[pageId] ?? [])
      .filter((entry) => this.routeAvailable({ page: pageId, segment: entry.id }))
      .map((entry) => ({ id: entry.id, label: entry.id === "hub" ? "Overview" : entry.label, hash: routeHash(pageId, entry.id) }));
  }

  /** At unlock, before the workspace shows: the set this device kept for
   * this household (`syncIdentity` null for one that doesn't sync). */
  restore(syncIdentity) {
    this.scope = syncIdentity?.householdId ?? "local";
    const cached = readFeatureCache(this.scope);
    this.off = cached?.off ?? 0;
    this.revision = cached?.revision ?? 0;
    this.noticed = cached?.noticed ?? this.off;
    this.known = Boolean(cached);
    // A household that doesn't sync has one person, who decides.
    this.admin = this.local;
    this.apply();
  }

  /** The service's value (`status.features`) for `householdId`. An older
   * revision than the one kept is a stale answer and changes nothing. */
  receive(features, { householdId = null } = {}) {
    const set = parseFeatureSet(features);
    if (!set) return false;
    if (householdId && householdId !== this.scope) {
      // The household now syncs (or is another one): the service decides.
      const cached = readFeatureCache(householdId);
      this.scope = householdId;
      this.revision = cached?.revision ?? -1;
      this.known = Boolean(cached);
      this.noticed = cached?.noticed ?? set.off;
    }
    this.admin = features.admin === true;
    this.heard = true;
    if (set.revision < this.revision) { this.app.householdFeatures?.render?.(); return false; }
    const before = this.off;
    this.off = set.off;
    this.revision = set.revision;
    // The first set this device hears of hid nothing it had shown.
    if (!this.known) this.noticed = this.off;
    this.known = true;
    // Switched back on, then off again later: tell again.
    this.noticed &= this.off;
    this.save();
    if (before !== this.off) this.apply();
    else {
      this.renderNote();
      this.app.householdFeatures?.render?.();
    }
    return true;
  }

  /** A change this device made: the service's answer, or the household's
   * own on a device that doesn't sync. The person who made it needs no note. */
  changed({ off, revision }) {
    this.off = off;
    this.revision = revision;
    this.noticed = off;
    this.known = true;
    this.save();
    this.apply();
  }

  save() {
    if (this.scope) writeFeatureCache({ scope: this.scope, off: this.off, revision: this.revision, noticed: this.noticed });
  }

  /** Puts the set into the workspace: navigation, the pages' segments,
   * links, Chat's actions, Search, Quick add, the palette, and the views'
   * data on the next render. A page that went away opens Today. */
  apply() {
    const root = rootDataset(), attribute = featuresAttribute(this.off);
    if (root && attribute) root.kinFeaturesOff = attribute;
    else if (root) delete root.kinFeaturesOff;
    if (!this.app.main) return;
    for (const [id, link] of this.app.navLinks ?? []) link.toggleAttribute("data-feature-hidden", !this.routeAvailable(id));
    for (const [pageId, nav] of this.app.segmentNavs ?? []) if (pageId !== "updates") nav.segments = this.segmentEntries(pageId);
    for (const node of this.app.querySelectorAll?.("[data-feature-route]") ?? [])
      node.toggleAttribute("data-feature-hidden", !this.routeAvailable(node.dataset.featureRoute));
    if (this.app.chat) this.app.chat.hiddenActions = new Set(hiddenChatActions(this.off));
    if (this.app.search) this.app.search.chatRoom = this.isOn("chat") ? this.app.chat?.room ?? null : null;
    if (this.app.quickAdd) this.app.quickAdd.repeatAllowed = this.isOn("routines");
    if (this.app.commandPalette) this.app.commandPalette.commands = availableCommands(COMMANDS, this.off);
    this.ctx.sections?.publish?.();
    this.ctx.rotations?.publish?.({ force: true });
    this.ctx.simple?.updateAccess?.();
    // The kitchen display's panels, or the display itself, leave (#670).
    this.ctx.display?.featuresChanged?.();
    this.ctx.views?.placeTalks?.();
    if (this.app.state && this.app.vault && !this.app.vault.locked) {
      this.ctx.render.renderState();
      this.ctx.privateItems?.refresh?.();
    }
    if (this.app.route && !this.routeAvailable(this.app.route)) this.ctx.navigation.showPageFromLocation();
    this.app.householdFeatures?.render?.();
    this.renderNote();
  }

  /** The calm one-time note on Today when something this member had
   * disappears (ADR 0021): what went, that nothing was deleted, and who can
   * bring it back. */
  renderNote() {
    const note = this.app.featuresNote;
    if (!note) return;
    const unseen = offFeatures(this.off & ~this.noticed);
    const text = turnedOffNote(unseen);
    note.hidden = !text || this.app.simpleView === true || this.app.displayMode === true;
    if (note.querySelector(".features-note-text")?.textContent !== text)
      note.querySelector(".features-note-text").textContent = text;
  }

  /** "OK" on the note: told once. */
  dismissNote() {
    this.noticed = this.off;
    this.save();
    this.renderNote();
  }
}
