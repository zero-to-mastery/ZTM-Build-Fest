// Rebuilding the projection from the event log: peer refresh, catch-up and timed refresh.
//
// State reaches the screen in two ways:
//   1. A local command: commands/append.js stores the projection that
//      engine.executeCommand returned with the new event. No refresh runs.
//   2. A refresh (this file): read the history from storage
//      (store.getCatchUpState), replay it (engine.applyEvents), render.
//      Callers: the peer channel when another tab wrote, onTimeWake (window
//      focus, visibility, the Pulse/midnight timer below), the Retry button,
//      and any refresh deferred while busy (`pendingRefresh`, run by
//      ctx.peers.flushPeerRefresh()).
// State stays on the element (`this.app`); see app/context.js.
import { projectionContext } from "../../browser-time.js";
import { captureFocus, restoreFocus } from "../shared/focus.js";

// A refresh runs at least this often while a Pulse or Routine can change with
// time alone; Rust decides expiry, the timer only asks for a fresh replay.
const MAX_TIME_REFRESH_MS = 60_000;

// The record a failed command acted on, found again in the refreshed state.
function retryTarget(intent, state) {
  if (intent.routineId) return state.routines.find((record) => record.routineId === intent.routineId);
  if (intent.talkId) return state.talks.find((record) => record.talkId === intent.talkId);
  if (intent.handoffId) return state.handoffs.find((record) => record.handoffId === intent.handoffId);
  return state.items.find((record) => record.itemId === intent.itemId);
}

// Status text when the target of a failed command changed meanwhile.
function changedTargetMessage(intent) {
  if (intent.routineId) return "That period changed. Review the current routine.";
  if (intent.talkId) return "That topic changed. Review its current state.";
  if (intent.handoffId) return "That handoff changed. Review its current state.";
  return "That item changed. Review its current state below.";
}

export class RefreshController {
  constructor(ctx) {
    this.ctx = ctx;
    this.app = ctx.app;
  }

  async refreshFromEvents() {
    if (!this.app.vault || this.app.vault.locked) return;
    if (!this.app.store || !this.app.engine || this.app.busy || this.app.refreshing) {
      this.app.pendingRefresh = true;
      return;
    }
    const session = this.ctx.session.captureSession();
    // Before the first await: a wake (wake.js) stops counting as pending as
    // soon as this call returns, so busy has to start here.
    this.app.refreshing = true;
    // Captured before busy disables the focused control.
    const focus = this.captureRefreshFocus();
    this.ctx.status.setBusy(true);
    // Retry bookkeeping. When a command fails, status.showAlert() stores its
    // message, a function that retries it (`retryAction`) and the record it
    // targeted (`retryIntent`). This refresh clears the alert, so remember
    // that failure first and offer it again afterwards. If the refresh itself
    // fails, its own Retry (`retryRefresh`) takes the alert and the command's
    // failure waits in `suspendedRetry` for the next successful refresh. A
    // failed refresh is never remembered as a command to re-offer.
    const previousFailure = this.app.suspendedRetry ?? {
      action: this.app.retryAction !== this.app.retryRefresh ? this.app.retryAction : null,
      intent: this.app.retryIntent,
      message: this.app.alert.textContent,
    };
    const previousRetry = previousFailure.action;
    const previousRetryIntent = previousFailure.intent;
    const previousAlert = previousFailure.message;
    this.ctx.status.clearAlert();
    // The common case is another tab's write; the same text covers the timer,
    // focus and Retry refreshes, which finish too quickly to need their own.
    this.ctx.status.setStatus("Updating from another tab…");
    try {
      const snapshot = await session.store.getCatchUpState();
      this.ctx.session.assertCurrentSession(session);
      this.applyCatchUpSnapshot(snapshot);
      this.ctx.render.renderState();
      this.ctx.status.setStatus("");
      if (previousRetry) {
        // Offer the failed command again only if its target still exists, is
        // not archived and (for a Routine) is still in the same period;
        // otherwise retrying could act on something the person never saw.
        const target = previousRetryIntent ? retryTarget(previousRetryIntent, this.app.state) : null;
        if (
          previousRetryIntent &&
          (!target ||
            target.status === "archived" ||
            (previousRetryIntent.occurrenceKey !== undefined &&
              target.occurrenceKey !== previousRetryIntent.occurrenceKey))
        ) {
          this.ctx.status.setStatus(changedTargetMessage(previousRetryIntent));
        } else {
          this.ctx.status.showAlert(previousAlert, previousRetry, previousRetryIntent);
        }
      }
    } catch (error) {
      if (error.code === "locked" || !this.ctx.session.isCurrentSession(session)) return;
      this.ctx.status.showAlert(
        error.userMessage ??
          "Kin could not refresh from local household storage. Your saved information was not deleted.",
        this.app.retryRefresh,
      );
      this.app.suspendedRetry = previousRetry ? previousFailure : null;
      this.ctx.status.setStatus("");
    } finally {
      if (this.ctx.session.isCurrentSession(session)) {
        this.app.refreshing = false;
        this.ctx.status.setBusy(false);
        this.restoreRefreshFocus(focus);
        this.ctx.peers.flushPeerRefresh();
      }
    }
  }
  // One snapshot of the focused control (shared/focus.js), taken before the
  // refresh rebuilds anything. A list or the routines view also describes
  // it, so it can find the equivalent control when that row was rebuilt; in a
  // composer (Quick capture, Handoffs, Talk) focus falls back to its input.
  captureRefreshFocus() {
    const focus = captureFocus(this.app);
    if (!focus) return null;
    const { today, needs, shopping, staples, routines, compose, handoffs, talks } = this.app;
    const owner = [today, needs, shopping, staples, routines].find((view) => view.contains(focus.control)) ?? null;
    const composer = [[compose, compose], [handoffs.lists, handoffs], [talks.lists, talks]]
      .find(([area]) => area.contains(focus.control))?.[1] ?? null;
    return { ...focus, owner, ownerFocus: owner?.captureFocus() ?? null, composer, inPulse: this.app.pulse.contains(focus.control) };
  }
  // Runs after busy is cleared, so nothing is disabled. During the render
  // the views also try to restore focus, but busy has disabled their controls
  // by then and focus has usually dropped to <body>; this restore is the one
  // that sticks.
  restoreRefreshFocus(focus) {
    if (!focus) return;
    const { owner, composer } = focus;
    if (composer) {
      // A list that did not change is not rebuilt, so the control may still be
      // there; otherwise the composer's input takes focus.
      if (!restoreFocus(focus)) composer.focusInput();
    } else if (owner) {
      owner.restoreFocus(focus.ownerFocus);
      // Routines always find a fallback (their Add button). A list whose row
      // vanished sends focus to its own quick-add; Today and lists on a hidden
      // page have none on screen, so the main capture field takes it.
      if (owner !== this.app.routines && !this.app.contains(document.activeElement)) {
        if (owner.closest("[hidden]") || owner === this.app.today) this.app.compose.focusInput();
        else owner.focusInput?.();
      }
    } else if (!restoreFocus(focus) && focus.inPulse) {
      this.app.pulse.focusInput();
    }
  }
  applyCatchUpSnapshot(snapshot) {
    if (!this.app.vault || this.app.vault.locked || !this.app.engine)
      throw new Error("Kin is locked.");
    const { asOf, civilDate } = projectionContext();
    const state = this.app.engine.applyEvents(
      snapshot.events,
      asOf,
      snapshot.cursor.eventId,
      civilDate,
      snapshot.syncIdentity,
    );
    // Rust's summary ends at the last event it replayed; storage says which
    // event that should be. A mismatch means the history read and the replay
    // disagree, so nothing is shown rather than a summary of other events.
    const throughEventId = state.summary.throughEventId;
    if (throughEventId !== (snapshot.through?.eventId ?? null)) {
      throw new Error(
        "Kin could not match its local catch-up snapshot boundary.",
      );
    }
    this.app.state = state;
    this.app.catchUpCursor = snapshot.cursor;
    // What "Caught up" commits (store.markCaughtUpThrough): the event to mark
    // as read (eventId, localSequence) and the last event of the snapshot the
    // person saw (snapshotThrough*). The store allows marking an earlier event
    // of the snapshot; the Caught up button marks all of it, so both match.
    this.app.snapshotBoundary = snapshot.through
      ? {
          eventId: snapshot.through.eventId,
          localSequence: snapshot.through.localSequence,
          snapshotThroughEventId: snapshot.through.eventId,
          snapshotThroughLocalSequence: snapshot.through.localSequence,
        }
      : null;
  }
  async handleCaughtUp() {
    if (this.app.busy || !this.app.store || !this.app.snapshotBoundary) return;
    const session = this.ctx.session.captureSession();
    const boundary = this.app.snapshotBoundary;
    const restoreCatchUpFocus = document.activeElement === this.app.catchUp.button;
    this.ctx.status.setBusy(true);
    this.ctx.status.clearAlert();
    this.ctx.status.setStatus("Saving catch-up state…");
    let committed = false;
    try {
      await session.store.markCaughtUpThrough(boundary);
      this.ctx.session.assertCurrentSession(session);
      committed = true;
      // Peers must learn about the commit even if this tab cannot reload it.
      this.ctx.peers.broadcastViewStateChange();
      const snapshot = await session.store.getCatchUpState();
      this.ctx.session.assertCurrentSession(session);
      this.applyCatchUpSnapshot(snapshot);
      this.ctx.render.renderState();
      this.ctx.status.setStatus(
        this.app.state.summary.totalCount === 0
          ? "Caught up."
          : "Catch-up summary updated.",
      );
    } catch (error) {
      if (error.code === "locked" || !this.ctx.session.isCurrentSession(session)) return;
      this.ctx.status.showAlert(
        committed
          ? "Your catch-up position was saved, but Kin could not refresh the summary. Try again to reload it."
          : (error.userMessage ??
              "Kin could not update this browser's catch-up position. Your saved household information was not deleted."),
        committed ? this.app.retryRefresh : () => this.ctx.refresh.handleCaughtUp(),
      );
      this.ctx.status.setStatus("");
    } finally {
      if (this.ctx.session.isCurrentSession(session)) {
        this.ctx.status.setBusy(false);
        if (restoreCatchUpFocus) {
          (this.app.catchUp.button.hidden
            ? this.app.catchUp.heading
            : this.app.catchUp.button
          ).focus();
        }
        this.ctx.peers.flushPeerRefresh();
      }
    }
  }
  // A fresh replay of the encrypted local log, without touching the rendered
  // projection, so undo checks the newest state including synced events.
  // It does become the engine's basis for reusing sections (kin-engine.js,
  // `lastState`). That is safe: reuse follows revisions, not app.state.
  async readAuthoritativeState(session) {
    const snapshot = await session.store.getCatchUpState();
    this.ctx.session.assertCurrentSession(session);
    const { asOf, civilDate } = projectionContext();
    return session.engine.applyEvents(
      snapshot.events,
      asOf,
      snapshot.cursor.eventId,
      civilDate,
      snapshot.syncIdentity,
    );
  }
  schedulePulseRefresh() {
    clearTimeout(this.app.pulseTimer);
    if (
      !this.app.isConnected ||
      (!this.app.state.pulses.length &&
        !this.app.state.routines?.some((r) => r.status === "active"))
    )
      return;
    // Timers only request canonical replay. Rust alone decides expiry. The
    // timer goes through onTimeWake (context.js), which also enforces
    // auto-lock and the durable security epoch before it refreshes.
    const now = Date.now();
    const active = this.app.state.pulses.filter(
      (pulse) => pulse.status === "active",
    );
    const midnight = new Date(now);
    midnight.setHours(24, 0, 0, 0);
    const delay = Math.max(
      1,
      Math.min(
        MAX_TIME_REFRESH_MS,
        midnight.getTime() - now,
        ...active.map((pulse) => pulse.expiresAt - now),
      ),
    );
    this.app.pulseTimer = setTimeout(this.app.onTimeWake, delay);
  }
  // Waits for the current operation to finish (attachments.js, before it
  // saves an attachment). Busy is a plain flag without a promise, so it polls.
  async untilIdle(limitMs = 10_000) {
    const deadline = Date.now() + limitMs;
    while (this.app.busy && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
    return !this.app.busy;
  }
}
