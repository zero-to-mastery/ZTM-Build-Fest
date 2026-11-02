// "Just for me" (#510): the member's private list, their own Today and This
// week, and moving items between private and the household.
// State stays on the element (`this.app`); app/context.js explains the controllers.
//
// The private log (web/private/private-log.js) arrives from the sync
// coordinator once this device holds the member key (`attach`). Until then,
// and without an account vault, Lists › Just for me says in one sentence
// that it needs an account (#557 wires the vault key; account setup is
// elsewhere). Regression scripts attach a log opened with a test-only vault
// key provider through this same seam (scripts/just-for-me-regression.mjs).
//
// What is private stays here: private items are fed only to Just for me, to
// this member's own Today and This week (setting on, never in Simple view),
// and to nothing else: not search, the sitter page, exports or any
// household record.
import {
  canMakePrivate, nextMakePrivateStep, nextShareStep, privateCopyId, sharedItemId, shareAudience, showPrivateOnToday,
} from "../../private-items.js";
import { itemArchivedEntry } from "../../undo.js";
import { assigneeLabel } from "../shared/assignee-label.js";
import { SAVE_ERROR } from "./constants.js";

const EMPTY = Object.freeze({ items: Object.freeze([]), onToday: true });
// A move is a handful of steps; this only stops a runaway loop.
const MAX_STEPS = 8;
const quoted = (text) => `“${text.length > 60 ? `${text.slice(0, 57)}…` : text}”`;

/** A user-facing reason a private change wasn't saved. */
function privateError(error) {
  if (error?.userMessage) return error;
  const message = error?.code === 4
    ? "That changed meanwhile, maybe on another of your devices. Have a look and try again."
    : typeof error?.code === "string" && error.message ? error.message : "Kin couldn't save that private change. Try again.";
  return Object.assign(error instanceof Error ? error : new Error(message), { userMessage: message });
}

export class PrivateItemsController {
  constructor(ctx) {
    this.ctx = ctx;
    this.app = ctx.app;
    this.log = null;
    this.unsubscribe = null;
    this.view = EMPTY;
  }

  /** The member's private log, or null when it closes (lock, stop). */
  attach(log) {
    if (this.log === (log ?? null)) return;
    this.unsubscribe?.();
    this.log = log ?? null;
    this.unsubscribe = this.log?.subscribe?.(() => this.refresh()) ?? null;
    this.refresh();
  }

  /** Lock: nothing private outlives the session. */
  reset() {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.log = null;
    this.view = EMPTY;
  }

  /** Whether Just for me works here: "ready", "off" (the household turned
   * private storage off for this member, or a Temporary member) or
   * "needs-account" (no account vault or vault key on this device). A log
   * without a member key yet is ready: the first change creates the key. */
  availability() {
    const log = this.log;
    if (!log) return { state: "needs-account" };
    const reason = log.reason;
    if (reason === "ready" || reason === "no_member_key") return { state: "ready" };
    if (reason === "off") return { state: "off" };
    return { state: "needs-account" };
  }

  read() {
    if (!this.log?.active) return EMPTY;
    try {
      const { items, onToday } = this.log.projection();
      return { items, onToday };
    } catch {
      // Keep what was shown; the next change or pass reads again.
      return this.view;
    }
  }

  /** The private items this member's Today and This week show: none in
   * Simple view or with the setting off. */
  todayItems() {
    // Just for me switched off (#625) leaves Today and This week too.
    if (this.ctx.features?.isOn("mine") === false) return EMPTY.items;
    return showPrivateOnToday({ onToday: this.view.onToday, simpleView: this.app.simpleView }) ? this.view.items : EMPTY.items;
  }

  /** Re-reads the list and redraws everything that shows it. */
  refresh() {
    this.view = this.read();
    const today = this.ctx.navigation?.currentCivilDate?.() ?? null;
    this.app.justForMe?.update({ availability: this.availability(), items: this.view.items, onToday: this.view.onToday, today });
    if (this.app.today && !this.app.simpleView) this.app.today.update({ privateItems: this.todayItems() });
    void this.ctx.week?.refresh();
    if (this.app.selection) this.ctx.detail.feedDetail();
  }

  /** Runs one private command (kin-private.js), creating the member key on
   * the member's first private change (ADR 0019). */
  async run(command) {
    const log = this.log;
    try {
      if (!log || log.closed) throw Object.assign(new Error("Just for me needs your Kin account on this device."), { userMessage: "Just for me needs your Kin account on this device." });
      if (!log.active && log.reason === "no_member_key") await log.enable();
      if (!log.active) {
        this.refresh();
        throw Object.assign(new Error("Private storage isn't available here."), {
          userMessage: log.reason === "off" ? "Your household has turned off private things for you." : "Just for me needs your Kin account on this device.",
        });
      }
      await log.execute(command);
    } catch (error) {
      throw privateError(error);
    }
    this.refresh();
  }

  /** Completes or reopens a private item from Today or This week. */
  async toggle({ itemId, completed }) {
    const item = this.view.items.find((entry) => entry.id === itemId);
    if (!item || Boolean(item.completed) === Boolean(completed)) return;
    try {
      await this.run({ type: completed ? "complete-private-item" : "reopen-private-item", itemId });
      this.ctx.status.setStatus(completed ? `Done: ${quoted(item.text)} (private).` : `Reopened ${quoted(item.text)} (private).`);
    } catch (error) {
      this.refresh();
      this.ctx.status.showAlert(error.userMessage ?? SAVE_ERROR, () => this.toggle({ itemId, completed }));
    }
  }

  /** The other members a shared item reaches, by name, for the
   * confirmation; null when no one else is in the household yet. */
  shareAudience() {
    const context = this.ctx.detail.responsibilityContext();
    const me = context.memberId;
    return shareAudience((context.memberIds ?? []).filter((id) => id && id !== me).map((id) => assigneeLabel(id, context)));
  }

  /**
   * "Share with the household…" (#517), after the member confirmed: add the
   * item to To do (with its date), then delete the private one. The
   * household item's ID is derived from the private one, so a retry after a
   * failure part-way finds what it already made: no duplicates.
   */
  async share(item) {
    if (!this.app.store || !this.app.engine) throw Object.assign(new Error("locked"), { userMessage: "Unlock Kin to share it." });
    const session = this.ctx.session.captureSession();
    const target = await sharedItemId(item.id);
    let changedHousehold = false;
    this.ctx.status.setBusy(true);
    this.ctx.status.clearAlert();
    try {
      for (let steps = 0; steps < MAX_STEPS; steps++) {
        const step = nextShareStep(item, target, this.app.state, this.view.items);
        if (!step) break;
        if (step.log === "household") {
          await this.ctx.append.appendCommand(step.command);
          changedHousehold = true;
        } else {
          await this.run(step.command);
        }
        this.ctx.session.assertCurrentSession(session);
      }
    } catch (error) {
      if (error.code === "locked" || !this.ctx.session.isCurrentSession(session)) throw error;
      if (changedHousehold) { this.ctx.render.renderState(); this.ctx.peers.broadcastEventChange(); }
      const message = changedHousehold
        ? `${quoted(item.text)} is in To do, but Kin couldn't take it out of Just for me yet. Try again to finish; it won't be added twice.`
        : privateError(error).userMessage ?? SAVE_ERROR;
      this.ctx.status.showAlert(message, () => void this.share(item));
      throw Object.assign(error, { userMessage: message });
    } finally {
      if (this.ctx.session.isCurrentSession(session)) this.ctx.status.setBusy(false);
    }
    if (changedHousehold) { this.ctx.render.renderState(); this.ctx.peers.broadcastEventChange(); }
    const message = `Shared ${quoted(item.text)} with the household. It's in To do.${this.ctx.sync.offlineSyncSuffix?.() ?? ""}`;
    this.ctx.status.setStatus(message);
    return { ok: true, message };
  }

  /** Whether "Make private" is offered for a household item: the member
   * added it, and private storage works here. */
  canMakePrivate(record) {
    if (this.app.simpleView || this.ctx.features?.isOn("mine") === false || this.availability().state !== "ready") return false;
    const memberId = this.app.syncCoordinator?.identity?.memberId ?? this.app.store?.actorId ?? null;
    return canMakePrivate(record, memberId);
  }

  /**
   * "Make private" (#517): copy a household item this member added into
   * Just for me, then archive it (others see it archived, as with Archive).
   * Undo brings the household item back and removes the private copy. The
   * copy's ID is derived from the household item's, so a retry never makes
   * two.
   */
  async makePrivate(itemId) {
    if (this.app.busy || !this.app.store || !this.app.engine) return;
    const record = this.app.state?.items?.find((item) => item.itemId === itemId) ?? null;
    if (!record || !this.canMakePrivate(record)) return;
    const session = this.ctx.session.captureSession();
    const before = this.app.state;
    const target = await privateCopyId(record.itemId);
    let known = false, archived = false;
    this.ctx.status.setBusy(true);
    this.ctx.status.clearAlert();
    this.ctx.status.setStatus("Saving…");
    try {
      for (let steps = 0; steps < MAX_STEPS; steps++) {
        const step = nextMakePrivateStep(record, target, this.app.state, this.view.items, known);
        if (!step) break;
        if (step.log === "household") {
          await this.ctx.append.appendCommand(step.command);
          this.app.localReminders.cancel(`item:${itemId}`);
          archived = true;
        } else {
          try {
            await this.run(step.command);
          } catch (error) {
            // An earlier try made the copy and it was deleted since: bring
            // it back rather than refuse.
            if (step.command.type !== "add-private-item" || error.code !== 4) throw error;
            await this.run({ type: "restore-private-item", itemId: target });
          }
          known = true;
        }
        this.ctx.session.assertCurrentSession(session);
      }
    } catch (error) {
      if (error.code === "locked" || !this.ctx.session.isCurrentSession(session)) return;
      this.ctx.render.renderState();
      this.ctx.status.setStatus("");
      const message = known && !archived
        ? `${quoted(record.text)} is in Just for me, but Kin couldn't archive the household copy yet. Try again to finish; it won't be copied twice.`
        : privateError(error).userMessage ?? SAVE_ERROR;
      this.ctx.append.showDetailActionError(itemId, message, () => this.makePrivate(itemId));
      return;
    } finally {
      if (this.ctx.session.isCurrentSession(session)) this.ctx.status.setBusy(false);
    }
    this.ctx.render.renderState();
    this.ctx.peers.broadcastEventChange();
    this.ctx.status.setStatus(`Made ${quoted(record.text)} private. It's in Just for me; your household sees it archived.`);
    const archive = itemArchivedEntry(itemId, before);
    if (archive) this.ctx.undo.record(Object.freeze({ ...archive, kind: "item-made-private", privateItemId: target, label: `make ${quoted(record.text)} private` }));
  }

  /** Undo of "Make private": once the household item is back, the private
   * copy goes. Already gone is fine. */
  async removeCopy(privateItemId) {
    if (!this.view.items.some((entry) => entry.id === privateItemId)) return;
    await this.run({ type: "delete-private-item", itemId: privateItemId });
  }
}
