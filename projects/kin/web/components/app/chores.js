// The chore chart (#676, ADR 0022 §6): reads the week's chart from Rust while
// the page is showing, hands the cards to <kin-chore-chart>, and records
// ticks, rewards, points per routine and joining with the ordinary commands.
// It also holds the admin's "adults can join" setting from the service.
// State stays on the element (`this.app`); app/context.js explains the
// controllers.
//
// Who is on the chart: Limited members (children) always; an Adult only when
// a household admin allows adults and they joined themselves. Rust decides
// from the member kinds this device learns from the household's device list
// (`app.activeMemberKinds`). A household that doesn't sync has one person,
// who decides: adults are allowed there.
import { SAVE_ERROR } from "./constants.js";
import { CHORE_PALETTE, buildChoreChart, chartMembers } from "../../chores/chore-chart-view.js";
import { CHORES_FORBIDDEN, JOIN_FORBIDDEN, canSendChoreCommand, normalizeRewardText } from "../../wasm/kin-chores.js";
import { choreRewardEntry } from "../../undo.js";
import { syncProgress } from "./feedback.js";

export class ChoresController {
  constructor(ctx) {
    this.ctx = ctx;
    this.app = ctx.app;
    this.reading = null;
    this.again = false;
    this.reset();
  }

  /** On lock: nothing known. */
  reset() {
    this.chart = null;
    // The views are rebuilt at the next unlock.
    this.app.choreChart = null;
    this.app.choreJoin = null;
    this.allowed = { adults: false, revision: -1, admin: false, heard: false };
  }

  /** This member's kind: from the service, or "adult" on a device with no
   * server membership (the household's only person). */
  get memberKind() {
    return this.app.householdStatus?.memberKind ?? (this.app.hasLocalSyncBinding ? null : "adult");
  }

  get local() {
    return !this.app.syncCoordinator && !this.app.hasLocalSyncBinding;
  }

  get selfId() {
    return this.ctx.detail.responsibilityContext().memberId;
  }

  /** What Household › Features shows (kin-chore-adults.js). */
  get setting() {
    return { ...this.allowed, adults: this.adultsAllowed, local: this.local };
  }

  get adultsAllowed() {
    return this.local || this.allowed.adults === true;
  }

  /** Whether this member is on the chart now (an Adult who joined). */
  get joined() {
    return Boolean(this.chart?.members.some((member) => member.memberId === this.selfId));
  }

  /** The service's value (`status.choreChart`). An older revision than the
   * one held is a stale answer. */
  receiveSetting(value) {
    if (!value || typeof value.adults !== "boolean" || !Number.isSafeInteger(value.revision)) return;
    if (value.revision < this.allowed.revision) return;
    const changed = value.adults !== this.allowed.adults;
    this.allowed = { adults: value.adults, revision: value.revision, admin: value.admin === true, heard: true };
    this.app.choreAdults?.render?.();
    if (changed) void this.refresh();
  }

  async reloadSetting() {
    try {
      const response = await fetch("/api/sync/status");
      const status = await response.json();
      if (status?.choreChart) this.receiveSetting(status.choreChart);
    } catch { /* keeps what it shows */ }
  }

  /** The query members: active children and Adults in join order (the
   * device directory's order). On a device that doesn't sync, just this
   * person, an Adult. */
  members() {
    const self = this.selfId;
    const ids = this.app.activeMemberIds ?? (self ? [self] : []);
    const kinds = new Map(this.app.activeMemberKinds ?? []);
    if (self && !kinds.has(self) && this.memberKind) kinds.set(self, this.memberKind);
    return chartMembers(ids, kinds);
  }

  /** Whether the chart page is showing (in either layout). */
  showing() {
    // The kitchen display (#671) shows the chart too.
    return (this.app.route?.page === "chores" || this.app.displayMode === true) && Boolean(this.app.choreChart);
  }

  /** Reads and draws the chart while it's showing, and the points per
   * routine while Routines is. Reads coalesce. */
  async refresh() {
    const routines = this.app.route?.page === "routines" && Boolean(this.app.routines);
    if (!routines && this.app.routines && this.app.routines.choreSettingsValue) this.app.routines.choreSettings = null;
    if (!(this.showing() || routines) || !this.app.store || !this.app.state) return;
    if (this.reading) { this.again = true; return this.reading; }
    const session = this.ctx.session.captureSession();
    this.reading = (async () => {
      try {
        const chart = await session.store.choreChart({ members: this.members(), adultsAllowed: this.adultsAllowed });
        // Members' own colours (event kind 74, the Calendar's), as palette
        // indices; anyone without one keeps the default by join order.
        let colours = null;
        try {
          const chosen = await session.store.memberColours?.();
          if (chosen instanceof Map) colours = new Map([...chosen].map(([id, index]) => [id, CHORE_PALETTE[index % CHORE_PALETTE.length]]));
        } catch { /* the defaults */ }
        if (!this.ctx.session.isCurrentSession(session)) return;
        this.chart = chart;
        this.colours = colours;
        // Routines offers each routine's points to Adults while the chart
        // is on (#676).
        if (this.app.routines) {
          const show = this.memberKind === "adult" && this.ctx.features?.isOn("chores") !== false && !this.app.simpleView;
          this.app.routines.choreSettings = show ? { points: chart.points } : null;
        }
        this.draw();
      } catch {
        // The page keeps what it showed; the next render tries again.
      } finally {
        this.reading = null;
        if (this.again) { this.again = false; void this.refresh(); }
      }
    })();
    return this.reading;
  }

  /** Puts the chart into the page: the cards, and for an Adult the reward
   * editor and Join or Leave. */
  draw() {
    const view = this.app.choreChart;
    if (!view || !this.chart) return;
    const context = this.ctx.detail.responsibilityContext();
    const adult = this.memberKind === "adult";
    // No reward editing on Simple view: ticking only. The kitchen display
    // (#699) offers it to the Adult whose device it is, touch-first
    // (<kin-chore-chart size="display">), with Undo.
    view.editable = adult && !this.app.simpleView;
    view.cards = buildChoreChart(this.chart, {
      state: this.app.state, emojis: this.app.itemEmojis ?? new Map(), rows: this.app.attachmentRows ?? [],
      order: context.memberIds, names: context.names, selfId: context.memberId, colours: this.colours ?? null,
    });
    const join = this.app.choreJoin;
    if (join) {
      const joined = this.joined;
      // Adults see Join only when an admin allows it; one who joined can
      // always leave.
      join.hidden = !adult || this.app.simpleView === true || (!joined && !this.adultsAllowed);
      join.querySelector(".chore-join-button").textContent = joined ? "Leave the chore chart" : "Join the chore chart";
      join.querySelector(".chore-join-hint").textContent = joined
        ? "You're on the chart with the children. Leave whenever you like; your points just stop showing."
        : "Join the children on the chart, for fun. It's your choice, and you can leave at any time.";
    }
  }

  /** A tick box on the chart: the ordinary complete and reopen commands. */
  async toggle({ kind, id, occurrenceKey, done, text }) {
    const command = kind === "item"
      ? { type: done ? "complete" : "reopen", itemId: id }
      : { type: done ? "complete-routine-occurrence" : "reopen-routine-occurrence", routineId: id, occurrenceKey };
    const result = await this.run(command, done ? `Ticked “${text}”.` : `Unticked “${text}”.`);
    if (!result.ok) this.draw();
    return result;
  }

  /** Join or leave (kind 79), for this member only. */
  setJoined(joined) {
    return this.run({ type: "set-chore-chart-joined", memberId: this.selfId, joined },
      joined ? "You joined the chore chart." : "You left the chore chart.");
  }

  /** A child's reward (kind 78): goal 0 and no text removes it. The same
   * path on the phone's chart and the kitchen display's; once saved, Undo
   * offers the reward it replaced (web/undo.js choreRewardEntry). On the
   * kitchen display (#705) the adult whose device it is confirms first,
   * at the moment of saving; cancelled or refused, nothing is written. */
  async setReward({ memberId, goal, text }) {
    if (this.app.displayMode === true && this.allows("set-chore-reward")) {
      const confirmed = await this.confirmOnDisplay();
      if (!confirmed) {
        this.ctx.status.setStatus("The reward wasn't changed.");
        this.app.choreChart?.focusReward?.(memberId);
        return { ok: false, canceled: true };
      }
    }
    // Read after any confirmation: the chart may have changed meanwhile.
    const from = this.rewardOf(memberId);
    const name = this.app.choreChart?.cards?.find?.((card) => card.memberId === memberId)?.name ?? null;
    const result = await this.run({ type: "set-chore-reward", memberId, goal, text: goal ? text : "" },
      goal ? "Reward saved." : "Reward removed.");
    if (result.ok) {
      let to = null;
      // Rust stored the text trimmed; a text it refused never got here.
      try { to = goal ? { goal, text: normalizeRewardText(text) } : null; } catch { return result; }
      this.ctx.undo?.record(choreRewardEntry({ memberId, name, from, to }));
    }
    return result;
  }

  /** The kitchen display's check for a reward change (#705): the adult's
   * passkey or password (app/display.js confirmAdult). Undo and Redo of a
   * reward ask through here too (app/undo.js). Resolves true when
   * confirmed, false otherwise. `onSettle(value)` is called synchronously
   * as the dialog closes (app/display.js confirmAdult). */
  async confirmOnDisplay({ onSettle = null } = {}) {
    try {
      return (await this.ctx.display?.confirmAdult?.("reward", { onSettle })) === true;
    } catch {
      return false;
    }
  }

  /** The reward the chart showed for `memberId`, or null. */
  rewardOf(memberId) {
    return this.chart?.members?.find((member) => member.memberId === memberId)?.reward ?? null;
  }

  /** Every charted member's reward as Rust works it out now: Map memberId
   * → { goal, text } or null. For Undo, which must compare against the
   * chart as it is, not as last drawn. */
  async rewards() {
    const chart = await this.app.store.choreChart({ members: this.members(), adultsAllowed: this.adultsAllowed });
    return new Map(chart.members.map((member) => [member.memberId, member.reward ?? null]));
  }

  /** A routine's points per completion (kind 77). */
  setPoints(routineId, points) {
    return this.run({ type: "set-chore-points", routineId, points }, "Points saved.");
  }

  /** Who may send a chore command: Rust can't tell member kinds apart. */
  allows(type) {
    return canSendChoreCommand(type, { memberKind: this.memberKind, adultsAllowed: this.adultsAllowed, joined: this.joined });
  }

  async run(command, done) {
    if (command.type.startsWith("set-chore") && !this.allows(command.type)) {
      const message = command.type === "set-chore-chart-joined" ? JOIN_FORBIDDEN : CHORES_FORBIDDEN;
      this.ctx.status.showAlert(message);
      return { ok: false, message };
    }
    if (this.app.busy || !this.app.store || !this.app.engine) {
      this.ctx.status.setStatus("Kin is still saving. Try again in a moment.");
      return { ok: false };
    }
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
      const progress = syncProgress({ syncing: Boolean(this.app.syncCoordinator), offline: navigator.onLine === false });
      if (done) this.ctx.status.setStatus(`${done}${progress}`);
      return { ok: true };
    } catch (error) {
      if (error.code === "locked" || !this.ctx.session.isCurrentSession(session)) return { ok: false };
      if (error.code === 4) this.app.pendingRefresh = true;
      this.ctx.status.setStatus("");
      const message = error.code === 4
        ? "That didn't change anything, or it changed on another device. Check and try again."
        : error.code === 2
          ? "Check the points or the reward and try again: a goal is 1 to 1000 points, a reward up to 120 letters."
          : (error.userMessage ?? SAVE_ERROR);
      this.ctx.status.showAlert(message);
      return { ok: false, message };
    } finally {
      if (this.ctx.session.isCurrentSession(session)) {
        this.ctx.status.setBusy(false);
        this.ctx.peers.flushPeerRefresh();
      }
    }
  }
}
