// The sitter page (#441, ADR 0017): reads the page from Rust while the
// editor or the For you page is showing, saves the editor's page, and sends
// a Temporary member to For you once per unlock.
// State stays on the element (`this.app`); app/context.js explains the controllers.
import { SAVE_ERROR } from "./constants.js";

export class SitterController {
  constructor(ctx) {
    this.ctx = ctx;
    this.app = ctx.app;
    this.reading = null;
    this.again = false;
  }

  /** Whether this member may change the page: Adults, and a household that
   * doesn't sync (its only member). Enforced again on the append path. */
  canEdit() {
    return (this.app.householdStatus?.memberKind ?? (this.app.hasLocalSyncBinding ? null : "adult")) === "adult";
  }

  showing() {
    const route = this.app.route;
    return route?.page === "foryou" || (route?.page === "household" && route.segment === "sitter");
  }

  refresh() {
    if (!this.showing() || !this.app.store) return null;
    if (this.reading) { this.again = true; return this.reading; }
    const session = this.ctx.session.captureSession();
    this.reading = (async () => {
      try {
        const page = await session.store.sitterPage();
        if (!this.ctx.session.isCurrentSession(session)) return;
        this.app.sitterPage = page;
        this.app.sitterEditor?.update({ page, state: this.app.state, canEdit: this.canEdit() });
        this.app.sitterView?.update({ page, state: this.app.state, preview: this.app.householdStatus?.memberKind !== "temporary" });
      } catch {
        // The page keeps what it showed; the next render tries again.
      } finally {
        this.reading = null;
        if (this.again) { this.again = false; void this.refresh(); }
      }
    })();
    return this.reading;
  }

  async save({ intro, entries }) {
    if (this.app.busy || !this.app.store || !this.app.engine) return { ok: false, message: "Kin is still saving another change. Try again in a moment." };
    const session = this.ctx.session.captureSession();
    this.ctx.status.setBusy(true);
    this.ctx.status.clearAlert();
    try {
      await this.ctx.append.appendCommand({ type: "set-sitter-page", intro, entries });
      this.ctx.session.assertCurrentSession(session);
      this.ctx.render.renderState();
      this.ctx.peers.broadcastEventChange();
      await this.refresh();
      this.ctx.status.setStatus("Sitter page saved.");
      return { ok: true };
    } catch (error) {
      if (error.code === "locked" || !this.ctx.session.isCurrentSession(session)) return { ok: false, message: "Kin locked." };
      if (error.code === "forbidden") return { ok: false, message: error.message };
      if (error.code === 4) {
        this.app.pendingRefresh = true;
        return { ok: false, message: "Nothing changed, or something on the page was archived meanwhile. Check and try again." };
      }
      if (error.code === 2) return { ok: false, message: "The welcome can be up to 500 characters, with at most 30 things on the page." };
      return { ok: false, message: error.userMessage ?? SAVE_ERROR };
    } finally {
      if (this.ctx.session.isCurrentSession(session)) {
        this.ctx.status.setBusy(false);
        this.ctx.peers.flushPeerRefresh();
      }
    }
  }

  /** A Temporary member lands on For you, once per unlock, from Today. */
  landTemporaryMember() {
    if (this.app.householdStatus?.memberKind !== "temporary" || this.app.sitterLanded || this.app.simpleView) return;
    // The sitter page switched off (#625): Today, as for everyone else.
    if (!this.ctx.features.isOn("sitter")) return;
    this.app.sitterLanded = true;
    if (this.app.route?.page === "today") this.ctx.navigation.navigate("#foryou");
  }
}
