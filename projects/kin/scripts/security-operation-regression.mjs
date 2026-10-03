// Real recovery, storage and UI flows with only crypto completion held back.
export async function securityOperationChecks(recovery) {
  const app = document.querySelector("kin-app");
  const { LocalVault, getActiveVault } = await import("/security/local-vault.js");
  const { EventStore } = await import("/storage/event-store.js");
  let checks = 0;
  const check = (ok, message) => {
    if (!ok) throw new Error(message);
    checks++;
  };

  for (const settleOlderWhilePending of [false, true]) {
    app.lockHousehold();
    const originalUnlock = LocalVault.unlock;
    const completions = [0, 1].map(() => {
      let release, reached;
      return {
        gate: new Promise((resolve) => { release = resolve; }),
        obtained: new Promise((resolve) => { reached = resolve; }),
        release: () => release(), reached: () => reached(), vault: null,
      };
    });
    let call = 0;
    LocalVault.unlock = async (...args) => {
      const completion = completions[call++];
      const vault = await originalUnlock.call(LocalVault, ...args);
      completion.vault = vault;
      completion.reached();
      await completion.gate;
      return vault;
    };
    let older, newer;
    try {
      older = app.security.run(() => app.security.unlockRecovery(recovery));
      await completions[0].obtained;
      app.lockHousehold();
      newer = app.security.run(() => app.security.unlockRecovery(recovery));
      await completions[1].obtained;

      if (settleOlderWhilePending) {
        completions[0].release();
        await older;
        check(app.security.busy && app.security.getAttribute("aria-busy") === "true",
          "cancelled unlock cleanup must preserve the newer operation's busy state");
        check(Array.from(app.security.querySelectorAll("button,input")).every((element) => element.disabled),
          "cancelled unlock cleanup must leave the newer operation's controls disabled");
        check(app.security.alert.textContent === "",
          "cancelled unlock must not add an error to the newer pending operation");
        check(app.security.phase === "locked" && app.main.hidden && !app.state && !app.vault,
          "newer pending unlock must remain genuinely locked until its crypto completes");
      }

      completions[1].release();
      await newer;
      const current = app.vault;
      check(current === completions[1].vault && !current.locked && app.security.phase === "unlocked",
        "newer recovery unlock establishes its own live vault and unlocked panel");
      const controls = Array.from(app.security.querySelectorAll("button,input"));
      if (!settleOlderWhilePending) {
        completions[0].release();
        await older;
      }
      check(completions[0].vault.locked && completions[0].vault.root === null,
        "cancelled older unlock always disposes its completed key capability");
      check(app.vault === current && getActiveVault() === current && !current.locked &&
        app.store && app.engine && app.state && !app.main.hidden,
        "late older completion must preserve the newer unlocked household capabilities");
      check(app.security.phase === "unlocked" && app.security.heading.textContent === "Household unlocked",
        "late older completion must not falsely label an unlocked household as locked");
      check(controls.every((control) => control.isConnected) &&
        controls.some((control) => control.textContent === "Lock household" && !control.disabled),
        "late older completion must preserve the current security controls and lock button");
      check(!app.security.busy && app.security.getAttribute("aria-busy") === "false" &&
        app.security.alert.textContent === "",
        "completed current unlock alone clears busy state without a stale cancellation error");
    } finally {
      for (const completion of completions) completion.release();
      await Promise.allSettled([older, newer]);
      LocalVault.unlock = originalUnlock;
      for (const completion of completions) {
        if (completion.vault !== app.vault) completion.vault?.lock();
      }
    }
  }

  // A failed credential also reloads public metadata before showing its error.
  // Locking during that reload must invalidate its catch and finally blocks.
  app.lockHousehold();
  const originalStatus = EventStore.securityStatus;
  let release, reached, calls = 0;
  const gate = new Promise((resolve) => { release = resolve; });
  const obtained = new Promise((resolve) => { reached = resolve; });
  EventStore.securityStatus = async () => {
    const call = ++calls;
    const manifest = await originalStatus.call(EventStore);
    if (call === 2) { reached(); await gate; }
    return manifest;
  };
  let failed;
  try {
    const wrongRecovery = (recovery[0] === "f" ? "e" : "f") + recovery.slice(1);
    failed = app.security.run(() => app.security.unlockRecovery(wrongRecovery));
    await obtained;
    app.lockHousehold();
    await app.security.run(() => app.security.unlockRecovery(recovery));
    const current = app.vault;
    const heading = app.security.heading;
    check(current && !current.locked && app.security.phase === "unlocked",
      "current unlock can finish while an older authentication error reloads metadata");
    release();
    await failed;
    check(app.vault === current && getActiveVault() === current && !current.locked && !app.main.hidden,
      "late error metadata must preserve the current household capabilities");
    check(app.security.heading === heading && app.security.phase === "unlocked",
      "late error metadata must not rerender the current security panel");
    check(app.security.alert.textContent === "" && !app.security.busy &&
      app.security.getAttribute("aria-busy") === "false",
      "late authentication error must not overwrite current feedback or busy state");
  } finally {
    release();
    await Promise.allSettled([failed]);
    EventStore.securityStatus = originalStatus;
  }
  return { checks };
}
