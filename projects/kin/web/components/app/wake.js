// Waking up: window focus, visibility changes and the Pulse/midnight timer.
// Sets the element's wake handlers (initializeAppState in context.js calls
// this); kin-app.js listens with them and refresh.js arms the timer.
//
// A wake counts as busy until its refresh starts (#793). Between the focus
// event and refreshFromEvents setting `app.refreshing`, the wake waits: 150 ms
// for the activating click to finish, then the security-epoch check. In that
// gap `app.wakePending` is true, so anything waiting for Kin to settle (the
// browser suites' idle checks) also waits for the refresh that is coming.
// Wakes can overlap (focus, then a visibility change), so it is a count.

/**
 * @param {object} app The <kin-app> element.
 * @param {(vault: object) => Promise<void>} checkSecurityEpoch Throws when
 *   another tab locked (EventStore.checkSecurityEpoch).
 */
export function installWakeHandlers(app, checkSecurityEpoch) {
  app.pendingWakes = 0;
  app.wakePending = false;
  app.focusTimer = null;
  const track = (change) => {
    app.pendingWakes += change;
    app.wakePending = app.pendingWakes > 0;
  };
  app.onWindowFocus = () => {
    // Let the interaction that activated the window finish before disabling controls.
    if (app.focusTimer === null) track(1);
    clearTimeout(app.focusTimer);
    app.focusTimer = setTimeout(() => {
      app.focusTimer = null;
      // onTimeWake counts itself before its first await, so the wake stays
      // pending without a gap.
      void app.onTimeWake();
      track(-1);
    }, 150);
  };
  // Lock and disconnect drop a focus wake that has not run yet.
  app.cancelFocusWake = () => {
    if (app.focusTimer === null) return;
    clearTimeout(app.focusTimer);
    app.focusTimer = null;
    track(-1);
  };
  // Three duties, in order: lock if the auto-lock time passed while away;
  // lock if another tab locked (the durable security epoch moved); otherwise
  // refresh from the event log and re-check household authorization.
  app.onTimeWake = async (event) => {
    if (event?.type === "focus" && event.target !== window) return;
    if (document.visibilityState === "hidden") return;
    const vault = app.vault;
    const generation = app.securityGeneration;
    if (app.autoLockMinutes && app.lastActivityAt !== null &&
      Date.now() - app.lastActivityAt >= app.autoLockMinutes * 60_000) {
      app.ctx.session.lockHousehold();
      app.ctx.status.setStatus("Kin locked after inactivity. Unlock to continue.");
      return;
    }
    // The vault becomes visible just before EventStore.open binds its durable
    // epoch. A focus/visibility event in that window must not compare an
    // unbound vault against storage and revoke an otherwise valid unlock.
    if (!vault || vault.locked || !app.store) return;
    track(1);
    try {
      try {
        await checkSecurityEpoch(vault);
      } catch {
        if (vault === app.vault && generation === app.securityGeneration)
          app.ctx.session.lockHousehold(false);
        return;
      }
      if (vault !== app.vault || generation !== app.securityGeneration)
        return;
      // Sets `app.refreshing` (or `pendingRefresh` while busy) before it
      // first awaits, so the wake hands over without looking idle.
      app.ctx.refresh.refreshFromEvents();
    } finally {
      track(-1);
    }
    void app.ctx.sync.checkHouseholdAuthorization();
  };
}
