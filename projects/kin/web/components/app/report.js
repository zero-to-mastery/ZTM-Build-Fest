// Reports and suggestions to the Kin team (#632, #628, ADR 0021 §3): the
// app's side of <kin-report>. It decides who is sending (signed in, which
// member, whether an admin), opens the dialog from every place that offers
// it, and sends the outbox when the device comes online or unlocks.
//
// Where "Report a problem" is offered: Household (the More place), the
// keyboard help, every error message, after an unexpected error, the lock
// screen and setup (signed out), and Help, which fires `kin:report-problem`
// (any element or the window may; this listens on the window). "Suggest
// something" is in Household › Features for admins (`kin:suggest-feature`),
// and "What I've sent" opens with `kin:feedback-sent`.
// State stays on the element (`this.app`); app/context.js explains the controllers.
import { collectDiagnostics } from "../../feedback/collect.js";
import { fetchChannel, fetchMine, sendOutboxItem } from "../../feedback/channel.js";
import { FeedbackOutbox, indexedDbOutboxStorage, memoryOutboxStorage } from "../../feedback/outbox.js";
import { captureViewport } from "../../feedback/screenshot.js";

export const REPORT_EVENTS = Object.freeze({ problem: "kin:report-problem", suggestion: "kin:suggest-feature", sent: "kin:feedback-sent" });

export class ReportController {
  constructor(ctx) {
    this.ctx = ctx;
    this.app = ctx.app;
    let storage;
    try { storage = globalThis.indexedDB ? indexedDbOutboxStorage() : memoryOutboxStorage(); } catch { storage = memoryOutboxStorage(); }
    this.outbox = new FeedbackOutbox({ storage, send: (item) => sendOutboxItem(item) });
  }

  /** Who is sending, from this device's current state. */
  context() {
    const unlocked = Boolean(this.app.vault && !this.app.vault.locked);
    const identity = unlocked ? this.app.household?.identity ?? null : null;
    return { signedIn: Boolean(identity), memberId: identity?.memberId ?? null, admin: Boolean(identity && this.app.householdAdmin) };
  }

  /** The <kin-report> element, made once and kept outside the views, so it
   * works on the lock screen too. */
  element() {
    if (this.app.report) return this.app.report;
    const report = document.createElement("kin-report");
    report.services = {
      context: () => this.context(),
      collect: () => collectDiagnostics({ app: this.app }),
      channel: () => fetchChannel(),
      capture: () => captureViewport(globalThis),
      outbox: this.outbox,
      fetchMine: () => fetchMine(),
    };
    this.app.report = report;
    this.app.append(report);
    return report;
  }

  /** Opens "problem", "suggestion" or "sent". */
  open(mode, { opener = null } = {}) {
    return this.element().open(mode, { opener });
  }

  /** A lock drops any draft and screenshot. */
  dismiss() {
    this.app.report?.dismiss();
  }

  /** Sends what waits, quietly; called when online and after unlocking. */
  flush() {
    const { signedIn, memberId } = this.context();
    return this.outbox.flush({ identity: signedIn ? { memberId } : null }).catch(() => []);
  }

  /** After an error nothing handled: one calm line offering a report. */
  offer() {
    if (!this.app.isConnected || this.app.report?.isOpen) return;
    const unlocked = Boolean(this.app.vault && !this.app.vault.locked);
    if (!unlocked || !this.app.reportButton) return;
    this.ctx.status.setStatus("Something went wrong in Kin. If it keeps happening, you can report a problem.");
    this.app.reportButton.hidden = false;
  }
}
