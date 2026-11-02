// Store sections for the Shopping list (#411, ADR 0015): reads the
// household's sections and each item's section from Rust after every render,
// hands them to shopping mode, and saves changes with the ordinary commands.
// State stays on the element (`this.app`); app/context.js explains the controllers.
import { SAVE_ERROR } from "./constants.js";

const EMPTY = Object.freeze({ sections: Object.freeze([]), itemSections: new Map() });
const newId = () => crypto.randomUUID().replaceAll("-", "");

export class SectionsController {
  constructor(ctx) {
    this.ctx = ctx;
    this.app = ctx.app;
    this.reading = null;
    this.again = false;
  }

  /** The current sections (`{ sections, itemSections }`). */
  get current() {
    return this.app.shoppingSections ?? EMPTY;
  }

  refresh() {
    if (this.reading) { this.again = true; return this.reading; }
    this.reading = this.load().finally(() => {
      this.reading = null;
      if (this.again) { this.again = false; void this.refresh(); }
    });
    return this.reading;
  }

  async load() {
    const session = this.ctx.session.captureSession();
    if (!session.store) return;
    let value;
    try { value = await session.store.shoppingSections(); } catch { return; }
    if (!this.ctx.session.isCurrentSession(session)) return;
    const previous = this.app.shoppingSections;
    const same = previous && JSON.stringify(previous.sections) === JSON.stringify(value.sections) &&
      previous.itemSections.size === value.itemSections.size && [...value.itemSections].every(([id, section]) => previous.itemSections.get(id) === section);
    if (same) return;
    this.app.shoppingSections = value;
    this.publish();
  }

  /** Hands the sections to shopping mode: none while Store sections is
   * switched off (#625), so the list shows in one group without pickers. */
  publish() {
    if (this.app.shoppingMode) this.app.shoppingMode.sections = this.ctx.features?.isOn("sections") === false ? EMPTY : this.current;
  }

  /** Saves the whole ordered list (`[{ sectionId?, name }]`). New sections
   * get an id here. Resolves `{ ok, message }`. */
  async saveSections(list) {
    const sections = list.map((section) => ({ sectionId: section.sectionId ?? newId(), name: String(section.name ?? "").trim() }));
    return this.run({ type: "set-shopping-sections", sections }, "Store sections saved.");
  }

  /** Puts an item in a section, or none (`sectionId` null). */
  async setItemSection(itemId, sectionId) {
    return this.run({ type: "set-item-section", itemId, sectionId: sectionId ?? null }, null);
  }

  async run(command, done) {
    if (this.app.busy || !this.app.store || !this.app.engine) return { ok: false, message: "Kin is still saving another change. Try again in a moment." };
    const session = this.ctx.session.captureSession();
    this.ctx.status.setBusy(true);
    this.ctx.status.clearAlert();
    try {
      await this.ctx.append.appendCommand(command);
      this.ctx.session.assertCurrentSession(session);
      this.ctx.render.renderState();
      this.ctx.peers.broadcastEventChange();
      await this.refresh();
      if (done) this.ctx.status.setStatus(done);
      return { ok: true };
    } catch (error) {
      if (error.code === "locked" || !this.ctx.session.isCurrentSession(session)) return { ok: false, message: "Kin locked." };
      const message = error.code === 4
        ? "That didn't change anything, or the list changed on another device. Check and try again."
        : error.code === 2
          ? "Each section needs a name of up to 40 characters, at most 30 sections."
          : (error.userMessage ?? SAVE_ERROR);
      if (error.code === 4) this.app.pendingRefresh = true;
      return { ok: false, message };
    } finally {
      if (this.ctx.session.isCurrentSession(session)) {
        this.ctx.status.setBusy(false);
        this.ctx.peers.flushPeerRefresh();
      }
    }
  }
}
