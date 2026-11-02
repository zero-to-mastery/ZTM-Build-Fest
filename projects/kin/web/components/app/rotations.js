// Taking turns on routines (#428, #433, #437, ADR 0016): reads the household's
// rotations from Rust after every render, works out whose turn it is among
// the members who are still active, hands that to Routines and Today, and
// saves rotation and turn changes with the ordinary commands.
// State stays on the element (`this.app`); app/context.js explains the controllers.
import { SAVE_ERROR } from "./constants.js";
import { turnAmong } from "../../wasm/kin-rotations.js";

const NONE = new Map();

export class RotationsController {
  constructor(ctx) {
    this.ctx = ctx;
    this.app = ctx.app;
    this.reading = null;
    this.again = false;
    this.raw = null;
  }

  /** routineId -> { memberIds, current, next } with inactive members passed
   * over; `current` is null when fewer than two are active. */
  get current() {
    return this.app.rotations ?? NONE;
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
    let list;
    try { list = await session.store.routineRotations(); } catch { return; }
    if (!this.ctx.session.isCurrentSession(session)) return;
    this.raw = list;
    this.publish();
    void this.reconcile();
  }

  /** Recomputes the turns (active members change without a new event).
   * `force` hands them on again, as after Taking turns is switched on or
   * off (#625): Today names whose turn it is only while it is on. */
  publish({ force = false } = {}) {
    const active = this.app.activeMemberIds ?? null;
    const next = new Map((this.raw ?? []).map((rotation) => [rotation.routineId, { memberIds: rotation.memberIds, ...turnAmong(rotation, active) }]));
    const previous = this.app.rotations;
    const same = previous && previous.size === next.size && [...next].every(([id, value]) => {
      const old = previous.get(id);
      return old && old.current === value.current && old.next === value.next && old.memberIds.join() === value.memberIds.join();
    });
    if (same && !force) return;
    this.app.rotations = next;
    if (this.app.routines) this.app.routines.rotations = next;
    if (this.app.today) this.app.today.turns = this.ctx.features?.isOn("turns") === false ? null : next;
  }

  /** Starts, changes (`memberIds` in turn order, first takes the next turn)
   * or ends (`[]`) a routine's rotation. Resolves `{ ok, message }`. */
  setRotation(routineId, memberIds) {
    const done = memberIds.length ? "Turns saved." : "Stopped taking turns.";
    return this.run({ type: "set-routine-rotation", routineId, memberIds, currentIndex: 0 }, done);
  }

  /** Gives the turn to a listed member (Skip to next, Give this turn to…). */
  setTurn(routineId, memberId) {
    return this.run({ type: "set-routine-turn", routineId, memberId }, "Turn changed.");
  }

  /**
   * When the member whose turn it is has left or their access ended, the turn
   * moves to the next active member, as a recorded change, so every device
   * agrees who owns the routine (ADR 0016). Runs only on a synced device that
   * knows who is active, one routine at a time.
   */
  async reconcile() {
    const active = this.app.activeMemberIds;
    if (!active || this.reconciling || this.app.busy || !this.app.store) return;
    if (!active.includes(this.app.syncCoordinator?.identity?.memberId)) return;
    const stale = (this.raw ?? []).find((rotation) => !active.includes(rotation.current) && turnAmong(rotation, active).current);
    if (!stale) return;
    this.reconciling = true;
    try {
      await this.run({ type: "set-routine-turn", routineId: stale.routineId, memberId: turnAmong(stale, active).current }, null);
    } finally {
      this.reconciling = false;
    }
  }

  async run(command, done) {
    if (this.app.busy || !this.app.store || !this.app.engine) return { ok: false, message: "Kin is still saving another change. Try again in a moment." };
    const session = this.ctx.session.captureSession();
    this.ctx.status.setBusy(true);
    this.ctx.status.clearAlert();
    try {
      await this.ctx.append.appendCommand(command);
      this.ctx.session.assertCurrentSession(session);
      const focus = this.ctx.refresh.captureRefreshFocus();
      this.ctx.render.renderState();
      this.ctx.refresh.restoreRefreshFocus(focus);
      this.ctx.peers.broadcastEventChange();
      await this.refresh();
      if (done) this.ctx.status.setStatus(done);
      return { ok: true };
    } catch (error) {
      if (error.code === "locked" || !this.ctx.session.isCurrentSession(session)) return { ok: false, message: "Kin locked." };
      if (error.code === 4) this.app.pendingRefresh = true;
      const message = error.code === 4
        ? "That didn't change anything, or the routine changed on another device. Check and try again."
        : error.code === 2
          ? "Taking turns needs 2 to 12 people, each once."
          : (error.userMessage ?? SAVE_ERROR);
      return { ok: false, message };
    } finally {
      if (this.ctx.session.isCurrentSession(session)) {
        this.ctx.status.setBusy(false);
        this.ctx.peers.flushPeerRefresh();
      }
    }
  }
}
