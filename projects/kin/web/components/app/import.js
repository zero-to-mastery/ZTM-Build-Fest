// Bringing lists into Kin (#452): opens the import dialog and saves its rows
// through the ordinary capture commands (add, planned date, complete), each
// row with a client id fixed when the import starts, so a retry after a
// partial failure resumes instead of adding anything twice.
// State stays on the element (`this.app`); app/context.js explains the controllers.
import { remainingImportSteps } from "../../import/list-import.js";
import { SAVE_ERROR } from "./constants.js";

const newId = () => crypto.randomUUID().replaceAll("-", "");

export class ImportController {
  constructor(ctx) {
    this.ctx = ctx;
    this.app = ctx.app;
  }

  /** Opens "Bring a list into Kin", optionally with pasted text. */
  open({ text = "", classification = "need", opener = null } = {}) {
    if (this.app.simpleView || this.app.displayMode || !this.app.importer || !this.ctx.navigation.workspaceReady()) return false;
    const existing = (this.app.state?.items ?? []).filter((item) => item.status === "active").map((item) => item.text);
    return this.app.importer.open({ text, classification, opener, existing, submit: (rows) => this.save(rows) });
  }

  async save(rows) {
    if (!this.app.store || !this.app.engine) return { ok: false, message: "Unlock Kin first." };
    if (this.app.busy) return { ok: false, message: "Kin is still saving another change. Try again in a moment." };
    // The same rows again (Add after a partial failure) resume that import
    // with the same ids, so nothing is added twice.
    const key = (list) => JSON.stringify(list.map(({ text, classification, planningDate, done }) => [text, classification, planningDate, done]));
    const pending = this.app.pendingImport;
    const batch = pending && key(pending) === key(rows) ? pending : rows.map((row) => ({ ...row, id: newId() }));
    this.app.pendingImport = batch;
    return this.run(batch);
  }

  async run(batch) {
    const session = this.ctx.session.captureSession();
    const steps = remainingImportSteps(this.app.state, batch);
    let done = 0;
    this.ctx.status.setBusy(true);
    this.ctx.status.clearAlert();
    try {
      for (const step of steps) {
        this.ctx.status.setStatus(`Adding ${Math.min(batch.length, done + 1)} of ${batch.length}…`);
        await this.ctx.append.appendCommand(step);
        this.ctx.session.assertCurrentSession(session);
        if (step.type === "add") done += 1;
      }
      if (this.app.pendingImport === batch) this.app.pendingImport = null;
      this.ctx.render.renderState();
      this.ctx.peers.broadcastEventChange();
      const lists = [...new Set(batch.map((row) => (row.classification === "shopping" ? "Shopping" : "To do")))].join(" and ");
      this.ctx.status.setStatus(`Added ${batch.length === 1 ? "1 item" : `${batch.length} items`} to ${lists}.${this.ctx.sync.offlineSyncSuffix?.() ?? ""}`);
      return { ok: true };
    } catch (error) {
      if (error.code === "locked" || !this.ctx.session.isCurrentSession(session)) return { ok: false, message: "Kin locked before the list was added." };
      if (error.code === 4) this.app.pendingRefresh = true;
      this.ctx.render.renderState();
      if (done) this.ctx.peers.broadcastEventChange();
      const message = done ? `Added ${done} of ${batch.length}. Try again to add the rest.` : (error.userMessage ?? SAVE_ERROR);
      this.ctx.status.showAlert(message, () => this.run(batch));
      this.ctx.status.setStatus("");
      return { ok: false, message };
    } finally {
      if (this.ctx.session.isCurrentSession(session)) {
        this.ctx.status.setBusy(false);
        this.ctx.peers.flushPeerRefresh();
      }
    }
  }
}
