// Turning a chat message into a record (#132). The dialog (kin-chat-share)
// collects the edited text; this saves it through the same commands as typing
// it in. Photos and files are copied only when chosen: each is re-encrypted
// as an ordinary household attachment of the new item or note. Nothing of the
// message (its id, author or time) is stored with the new record.

const CLASSIFICATIONS = { shopping: "shopping", todo: "need" };

const newId = () => crypto.randomUUID().replaceAll("-", "");

export class ChatShareController {
  constructor(ctx) {
    this.ctx = ctx;
    this.app = ctx.app;
  }

  open(detail) {
    const dialog = this.app.chatShare;
    // Simple view (#341, ADR 0013) adds nothing.
    if (!dialog || !detail || this.app.simpleView || this.app.displayMode) return;
    dialog.open({ ...detail, submit: (payload) => this.save(payload) });
  }

  async save({ kind, text, title, body, files = [] }) {
    const { app } = this;
    if (app.simpleView) return { ok: false, message: "Simple view doesn't add things." };
    if (!app.store || !app.engine || app.vault?.locked) return { ok: false, message: "Unlock Kin first." };
    if (app.busy) return { ok: false, message: "Kin is still saving another change. Try again in a moment." };
    if (app.pendingCapture) return { ok: false, message: "An earlier item is only partly saved. Finish it from Today first." };
    let parentKind = null;
    let parentId = null;
    if (kind === "shopping" || kind === "todo") {
      parentKind = "item";
      parentId = newId();
      // handleAddItem reports to whatever form submitted the item.
      const outcome = { saved: false, failure: null };
      const composer = {
        isConnected: true,
        clearIfMatches() { outcome.saved = true; },
        showResult(message, { kind: resultKind = "saved" } = {}) { if (resultKind === "error") outcome.failure = message; },
        showPendingCapture() { outcome.failure = "An earlier item is only partly saved. Finish it first."; },
        clearResult() {},
        focusInput() {},
      };
      await this.ctx.items.handleAddItem({
        detail: { text, classification: CLASSIFICATIONS[kind], planningDate: null, pinned: false, cadence: null, id: parentId, composer, revision: 0 },
      });
      if (!outcome.saved) {
        // This form owns the failure: no retry or half-saved capture is left
        // behind for another form to trip over.
        if (app.pendingCapture?.composer === composer) app.pendingCapture = null;
        this.ctx.status.clearAlert();
        return { ok: false, message: outcome.failure ?? "Kin couldn't save that. Try again." };
      }
    } else if (kind === "handoff") {
      if (!(await this.ctx.conversations.saveHandoff({ type: "add-handoff", text }))) return { ok: false, message: "Kin couldn't save that. Try again." };
    } else if (kind === "note") {
      parentKind = "note";
      parentId = newId();
      if (!(await this.ctx.records.saveNote("create-note", { title, body, areaId: null, noteId: parentId }, { fromChat: true })))
        return { ok: false, message: "Kin couldn't save that. Try again." };
    } else {
      return { ok: false, message: "Kin can't do that." };
    }
    const problems = parentKind ? await this.copyFiles(files, parentKind, parentId) : [];
    return { ok: true, itemId: parentKind === "item" ? parentId : null, problems, message: null };
  }

  /** Each chosen file becomes a household attachment of the new record.
   * The record is already saved, so a file that fails is reported by name
   * and the rest still go. */
  async copyFiles(files, parentKind, parentId) {
    const problems = [];
    for (const file of files) {
      try {
        const blob = await file.load();
        if (!blob) throw new Error("missing");
        const copy = new File([blob], file.name, { type: file.type || blob.type });
        const saved = await this.ctx.attachments.handleAddAttachment({ detail: { file: copy, parentKind, parentId } });
        if (!saved?.ok) problems.push(`${file.name} couldn't be added${saved?.message ? `: ${saved.message}` : "."}`);
      } catch {
        problems.push(`${file.name} couldn't be added.`);
      }
    }
    return problems;
  }
}
