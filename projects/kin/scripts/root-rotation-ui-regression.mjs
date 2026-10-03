// Production recovery controls, cancellation, restart and independently keyed
// archives; only the operation checkpoint is delayed for deterministic locking.
export async function rootRotationUiChecks(oldRecovery) {
  const app = document.querySelector("kin-app");
  const { EventStore } = await import("/storage/event-store.js");
  const { LocalVault } = await import("/security/local-vault.js");
  const { exportHouseholdArchive } = await import("/security/archive.js");
  let checks = 0;
  const check = (value, message) => { if (!value) throw Error(message); checks++; };
  const wait = async (condition) => {
    for (let i = 0; i < 400; i++) {
      if (condition()) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw Error("Root rotation UI did not settle");
  };
  if (!app.vault) await app.security.run(() => app.security.unlockRecovery(oldRecovery));
  const before = await EventStore.securityStatus();
  const originalBytes = (await app.store.loadEvents()).map((row) => Array.from(row.encoded_event));
  app.security.showReplacement();
  const recovery = app.security.querySelector(".recovery-key").textContent;
  check(recovery.length === 64 && recovery !== oldRecovery, "replacement displays a fresh complete recovery key");
  const confirmation = app.security.querySelector("#confirm-replacement");
  check(document.activeElement === confirmation, "replacement confirmation receives keyboard focus");
  confirmation.value = oldRecovery;
  confirmation.form.requestSubmit();
  check((await EventStore.securityStatus()).rootVersion === before.rootVersion && !app.security.busy,
    "wrong confirmation cannot make replacement authoritative");
  confirmation.value = recovery;
  confirmation.form.requestSubmit();
  await wait(() => !app.security.busy && Boolean(app.store));
  check(app.security.alert.textContent === "", "replacement finishes without security errors");
  check(app.security.message.textContent.includes("Recovery protection updated"), "replacement announces success");
  const after = await EventStore.securityStatus();
  check(after.rootVersion === before.rootVersion + 1 && after.wrappers.length === 1,
    "UI publishes exactly the next root and only the new recovery wrapper");
  check(JSON.stringify((await app.store.loadEvents()).map((row) => Array.from(row.encoded_event))) === JSON.stringify(originalBytes),
    "replacement preserves canonical bytes through real UI");
  check(!document.body.textContent.includes(recovery), "completed replacement removes displayed recovery key");
  const archive = await exportHouseholdArchive({ store: app.store, engine: app.engine, vault: app.vault });
  check(archive.byteLength > 16, "rotated root exports a real KARC v1 archive");
  app.lockHousehold();
  await app.security.run(() => app.security.unlockRecovery(oldRecovery));
  check(!app.vault && app.main.hidden, "old recovery cannot unlock after UI rotation");
  await app.security.run(() => app.security.unlockRecovery(recovery));
  check(app.vault?.rootVersion === after.rootVersion, "new recovery reopens complete household");

  app.security.showReplacement();
  const resumedRecovery = app.security.querySelector(".recovery-key").textContent;
  const originalRotate = EventStore.rotateProtection;
  let reached, release, operationVault;
  const started = new Promise((resolve) => { reached = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  EventStore.rotateProtection = async (options) => originalRotate.call(EventStore, {
    ...options,
    onPhase: async (phase) => {
      await options.onPhase?.(phase);
      if (phase === "events-staged") {
        operationVault = options.candidateVault;
        reached();
        await gate;
      }
    },
  });
  try {
    const pending = app.security.run(() => app.security.replaceProtection(resumedRecovery));
    await started;
    check(app.main.hidden && !app.store && !app.engine && !app.vault, "rotation disposes ordinary household capabilities");
    app.lockHousehold();
    check(operationVault.locked, "manual lock disposes operation-owned candidate immediately");
    release();
    await pending;
    await app.lockBarrier;
    check((await EventStore.securityStatus()).phase === "root-rotating", "interrupted rotation retains durable journal");
    await app.security.run(() => app.security.unlockRecovery(resumedRecovery));
    check(app.store && app.vault?.rootVersion === after.rootVersion + 1, "new recovery resumes exact interrupted UI rotation");
    check((await EventStore.securityStatus()).phase === "encrypted", "resume completes cleanup before showing household");
    const obsolete = await LocalVault.unlock(before, oldRecovery);
    check(obsolete.rootVersion === before.rootVersion, "old copied wrapper still represents only its original root");
    obsolete.lock();
  } finally { release(); EventStore.rotateProtection = originalRotate; }
  return { checks, recovery: resumedRecovery };
}
