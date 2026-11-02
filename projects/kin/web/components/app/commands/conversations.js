// Handoff, Talk and Pulse commands.
// State stays on the element (`this.app`); app/context.js explains the controllers.
import { routeHash } from "../../../routes.js";
import { SAVE_ERROR } from "../constants.js";

export class ConversationCommands {
  constructor(ctx) {
    this.ctx = ctx;
    this.app = ctx.app;
  }

  async handleAddHandoff(event) {
    return this.saveHandoff({ type: "add-handoff", text: event.detail.text });
  }
  async handleHandoffAction(type, handoffId) {
    return this.saveHandoff({ type, handoffId });
  }
  async saveHandoff(command) {
    if (this.app.busy || !this.app.store || !this.app.engine) return;
    const session = this.ctx.session.captureSession();
    const submitted = Object.freeze({ ...command });
    this.ctx.status.setBusy(true);
    this.ctx.status.clearAlert();
    this.ctx.status.setStatus("Saving…");
    try {
      await this.ctx.append.appendCommand(submitted);
      this.ctx.session.assertCurrentSession(session);
      this.ctx.render.renderState();
      if (submitted.type === "add-handoff")
        this.app.handoffs.clearIfMatches(submitted);
      this.ctx.status.setStatus(
        submitted.type === "add-handoff"
          ? "Handoff added."
          : submitted.type === "acknowledge-handoff"
            ? "Acknowledged."
            : "Handoff archived.",
      );
      this.ctx.peers.broadcastEventChange();
      return true;
    } catch (error) {
      if (error.code === "locked" || !this.ctx.session.isCurrentSession(session)) return false;
      if (error.code === 4 && submitted.handoffId) this.app.pendingRefresh = true;
      this.ctx.status.showAlert(
        error.userMessage ?? SAVE_ERROR,
        () => this.saveHandoff(submitted),
        submitted.handoffId ? submitted : null,
      );
      this.ctx.status.setStatus("");
      return false;
    } finally {
      if (this.ctx.session.isCurrentSession(session)) {
        this.ctx.status.setBusy(false);
        this.app.handoffs.focusInput();
        this.ctx.peers.flushPeerRefresh();
      }
    }
  }
  async saveTalk(command) {
    if (this.app.busy || !this.app.store || !this.app.engine) return;
    const session = this.ctx.session.captureSession();
    const submitted = Object.freeze({ ...command });
    this.ctx.status.setBusy(true);
    this.ctx.status.clearAlert();
    this.ctx.status.setStatus("Saving…");
    try {
      await this.ctx.append.appendCommand(submitted);
      this.ctx.session.assertCurrentSession(session);
      this.ctx.render.renderState();
      if (submitted.type === "add-talk") this.app.talks.clearIfMatches(submitted);
      this.ctx.status.setStatus(
        submitted.type === "add-talk"
          ? "Talk added."
          : submitted.type === "resolve-talk"
            ? "Resolved."
            : submitted.type === "reopen-talk"
              ? "Reopened."
              : "Talk archived.",
      );
      this.ctx.peers.broadcastEventChange();
    } catch (error) {
      if (error.code === "locked" || !this.ctx.session.isCurrentSession(session)) return;
      if (error.code === 4 && submitted.talkId) this.app.pendingRefresh = true;
      this.ctx.status.showAlert(
        error.userMessage ?? SAVE_ERROR,
        () => this.ctx.conversations.saveTalk(submitted),
        submitted.talkId ? submitted : null,
      );
      this.ctx.status.setStatus("");
    } finally {
      if (this.ctx.session.isCurrentSession(session)) {
        this.ctx.status.setBusy(false);
        this.app.talks.focusInput();
        this.ctx.peers.flushPeerRefresh();
      }
    }
  }
  async savePulse(command) {
    if (this.app.busy || !this.app.store || !this.app.engine) return;
    const session = this.ctx.session.captureSession();
    const submitted = Object.freeze({ ...command });
    this.ctx.status.setBusy(true);
    this.ctx.status.clearAlert();
    this.ctx.status.setStatus("Saving…");
    try {
      await this.ctx.append.appendCommand(submitted);
      this.ctx.session.assertCurrentSession(session);
      this.ctx.render.renderState();
      this.app.pulse.saved();
      this.ctx.status.setStatus(
        submitted.type === "set-pulse" ? "Pulse set." : "Pulse cleared.",
      );
      this.ctx.peers.broadcastEventChange();
    } catch (error) {
      if (error.code === "locked" || !this.ctx.session.isCurrentSession(session)) return;
      this.ctx.status.showAlert(error.userMessage ?? SAVE_ERROR, () =>
        this.ctx.conversations.savePulse(submitted),
      );
      this.ctx.status.setStatus("");
    } finally {
      if (this.ctx.session.isCurrentSession(session)) {
        this.ctx.status.setBusy(false);
        this.app.pulse.focusInput();
        this.ctx.peers.flushPeerRefresh();
      }
    }
  }
  // Kept for callers that switched the former Handoff/Talk tabs directly.
  showHandoffPanel(id, focus = false) {
    this.ctx.navigation.navigate(id === "talk" ? "#updates/talk" : routeHash("updates", "handoffs"));
    if (focus) this.app.segmentNavs.get("updates")?.focusCurrent();
  }
}
