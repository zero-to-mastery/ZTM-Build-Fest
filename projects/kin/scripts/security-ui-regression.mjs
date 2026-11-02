// Real browser IndexedDB + Web Crypto regressions; no third-party harness.
import { BROWSER_STDIO, waitForDevTools } from "./browser-launch.mjs";
import { applyRegressionDefaults, captureFailure, createLoadTrace, printAbortedModules, printLoadTrace, waitForKinStart } from "./cdp-page.mjs";
import assert from "node:assert/strict";
import { householdLifecycleChecks } from "./security-household-regression.mjs";
import { householdLeaveChecks } from "./household-leave-regression.mjs";
import { securityOperationChecks } from "./security-operation-regression.mjs";
import { rootRotationUiChecks } from "./root-rotation-ui-regression.mjs";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

// A passing run ends the process here, so the caller's `finally` never runs:
// `beforeExit` prints what it must print on a pass too.
export async function securityUiRegressions(client, { beforeExit = () => {} } = {}) {
  // Names the step (and any navigation) when one fails, without printing its
  // arguments: the synthetic recovery secret stays in this process only.
  const step = async (name, expression) => {
    try {
      return await client.evaluate(expression);
    } catch (error) {
      error.message = `${name}: ${error.message}${client.navigations?.length ? `; top-level navigations: ${client.navigations.join(", ")}` : ""}`;
      throw error;
    }
  };
  const result = await step("core security UI checks", `(${browserUiChecks.toString()})()`);
  assert.ok(result.checks >= 25);
  console.log(`PASS ${result.checks} core security UI assertions`);
  const operations = await step("security operation checks", `(${securityOperationChecks.toString()})(${JSON.stringify(result.recovery)})`);
  console.log(`PASS ${operations.checks} overlapping security operation assertions`);
  const lifecycle = await step("household lifecycle checks", `(${householdLifecycleChecks.toString()})(${JSON.stringify(result.recovery)})`);
  console.log(`PASS ${lifecycle.checks} household lifecycle cancellation assertions`);
  const leave = await step("household leave checks", `(${householdLeaveChecks.toString()})()`);
  console.log(`PASS ${leave.checks} household leave component assertions`);
  const rotation = await step("root rotation UI checks", `(${rootRotationUiChecks.toString()})(${JSON.stringify(result.recovery)})`);
  result.recovery = rotation.recovery;
  console.log(`PASS ${rotation.checks} root rotation UI assertions`);
  await client.send("Page.enable");
  await client.send("Network.enable");
  await client.evaluate("globalThis.__kinReloadSentinel = true");
  await client.send("Network.emulateNetworkConditions", {
    offline: true,
    latency: 0,
    downloadThroughput: 0,
    uploadThroughput: 0,
  });
  try {
    await client.send("Page.reload", { ignoreCache: false });
    let ready = false;
    for (let attempt = 0; attempt < 400 && !ready; attempt++) {
      try {
        ready = await client.evaluate(
          "!globalThis.__kinReloadSentinel && Boolean(document.querySelector('kin-app')?.security?.manifest) && !document.querySelector('kin-app').starting",
        );
      } catch {
        /* Reload destroys the old execution context. */
      }
      if (!ready) await delay(25);
    }
    assert.ok(ready, "Offline application shell did not load");
    const offline = await client.evaluate(
      `(${offlineReloadChecks.toString()})(${JSON.stringify(result.recovery)})`,
    );
    console.log(
      `PASS ${result.checks + operations.checks + lifecycle.checks + leave.checks + rotation.checks + offline.checks} application lock, recovery, peer-tab and offline assertions`,
    );
    console.log(JSON.stringify({ ...result.timings, ...offline.timings }));
  } finally {
    await client.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
    });
  }
  beforeExit();
  process.exit(0);
}

async function offlineReloadChecks(recovery) {
  let checks = 0;
  const check = (ok, message) => {
    if (!ok) throw Error(message);
    checks++;
  };
  const app = document.querySelector("kin-app");
  check(!navigator.onLine, "browser is actually offline");
  check(
    app.state === null &&
      app.engine === null &&
      app.store === null &&
      app.vault === null,
    "offline reload starts without household/key capabilities",
  );
  check(
    app.main.hidden &&
      !document.body.textContent.includes("Synthetic protected"),
    "offline shell displays no household plaintext",
  );
  check(
    Boolean(navigator.serviceWorker.controller),
    "offline document is controlled by the static shell service worker",
  );
  check(
    Boolean(app.security.querySelector("#recovery-unlock")),
    "offline locked shell offers explicit recovery unlock",
  );
  const started = performance.now();
  await app.security.run(() => app.security.unlockRecovery(recovery));
  check(
    app.state?.items[0]?.text === "Synthetic protected household secret",
    "offline recovery decrypts and replays persisted household",
  );
  const elapsed = performance.now() - started;
  const oldEngine = app.engine;
  const oldShoppingList = app.shopping;
  const oldStaplesList = app.staples;
  app.shopping.items = [{
    itemId: "11".repeat(16),
    createdBy: "22".repeat(16),
    createdAt: 1,
    classification: "shopping",
    status: "active",
    areaId: null,
    steps: [],
    text: "Synthetic Shopping lock sentinel",
  }];
  app.staples.items = [{
    itemId: "33".repeat(16),
    createdBy: "22".repeat(16),
    createdAt: 1,
    classification: "staple",
    status: "active",
    areaId: null,
    steps: [],
    text: "Synthetic Staples lock sentinel",
  }];
  app.ctx.session.lockHousehold();
  let denied = false;
  try {
    oldEngine.applyEvents([], 1234, null, 20261003);
  } catch {
    denied = true;
  }
  check(
    denied &&
      app.state === null &&
      app.shopping !== oldShoppingList &&
      app.staples !== oldStaplesList &&
      app.shopping.records.length === 0 &&
      app.staples.records.length === 0 &&
      !document.body.textContent.includes("Synthetic protected") &&
      !document.body.textContent.includes("Synthetic Shopping lock sentinel") &&
      !document.body.textContent.includes("Synthetic Staples lock sentinel"),
    "offline lock clears Shopping and Staples plaintext and revokes old engine",
  );
  return { checks, timings: { offlineUnlockAndReplayMs: elapsed } };
}

async function browserUiChecks() {
  let checks = 0;
  const check = (ok, message) => {
    if (!ok) throw Error(message);
    checks++;
  };
  const wait = async (condition) => {
    for (let i = 0; i < 400; i++) {
      if (condition()) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw Error("UI wait timed out: " + document.body.innerText);
  };
  // A fresh profile's first start can take longer than wait()'s 10 s on the
  // Windows runner (#164); give it 30 s.
  for (let i = 0; i < 1200 && !(document.querySelector("kin-app")?.security?.heading && !document.querySelector("kin-app").starting); i++)
    await new Promise((r) => setTimeout(r, 25));
  await wait(
    () =>
      document.querySelector("kin-app")?.security?.heading &&
      !document.querySelector("kin-app").starting,
  );
  const app = document.querySelector("kin-app");
  check(
    app.state === null &&
      app.engine === null &&
      app.store === null &&
      app.vault === null,
    "startup has no projection/engine/store/key",
  );
  check(app.main.hidden, "locked startup shell only");
  // #557: a first visit starts with the gentle first run; the passkey and
  // backup-key setup checked below is one tap away.
  const buttonNamed = (label) => [...app.security.querySelectorAll("button")].find((button) => button.textContent === label);
  check(
    app.security.heading.textContent === "Welcome to Kin" &&
      app.security.dataset.firstRunStep === "welcome" &&
      Boolean(buttonNamed("Start a new household")) && Boolean(buttonNamed("I have an invitation")) &&
      !app.security.querySelector("#recovery-unlock") && !app.security.querySelector(".recovery-key"),
    "first visit offers the first run, with no keys to see: " + app.security.heading.textContent,
  );
  buttonNamed("Set up with a passkey instead").click();
  check(
    app.security.heading.textContent === "Welcome to Kin" &&
      Boolean(buttonNamed("Set up protection")) &&
      !app.security.querySelector("#recovery-unlock") &&
      app.security.textContent.includes("Passkey unlock is for everyday use"),
    "the passkey setup explains itself instead of asking for a key: " + app.security.heading.textContent,
  );
  app.security.showSetup();
  let recovery = app.security.querySelector(".recovery-key").textContent;
  check(recovery.length === 64, "setup displays user-held recovery secret");
  check(
    app.security.heading.textContent === "Save your backup key for this device" &&
      app.security.querySelector("#confirm-recovery")?.type === "checkbox" &&
      app.security.querySelector("#confirm-recovery").labels?.[0]?.textContent.includes("saved this key") &&
      app.security.querySelector('input[autocomplete="new-password"]')?.value === recovery,
    "setup asks the person to save the key, not retype it, and offers it to the password manager",
  );
  // Not wait(): its timeout message would print the displayed recovery key.
  for (let i = 0; i < 400 && !/backup key K-[0-9A-F]{4}/.test(app.security.querySelector(".recovery-key-label")?.textContent ?? ""); i++)
    await new Promise((r) => setTimeout(r, 25));
  check(/backup key K-[0-9A-F]{4}/.test(app.security.querySelector(".recovery-key-label")?.textContent ?? ""), "setup shows the new key's label");
  check(app.security.textContent.includes("Each device has its own"), "setup says the backup key belongs to this device");
  const setupLabel = /K-[0-9A-F]{4}/.exec(app.security.querySelector(".recovery-key-label").textContent)[0];
  // #579: the entry carries this device's automatic name and the key's label.
  const { automaticDeviceName, currentPlatform } = await import("/platform.js");
  const { backupKeyEntryName, BACKUP_KEY_ENTRY_KEY } = await import("/security/backup-key-entry.js");
  // Named in the same step that shows the label, which the loop above waited for.
  const setupEntry = backupKeyEntryName(setupLabel, automaticDeviceName(currentPlatform()));
  check(app.security.querySelector('input[autocomplete="username"]')?.value === setupEntry && setupEntry.endsWith(`(${setupLabel})`),
    "the password-manager entry is named for this device and key label, so another device's key isn't overwritten or offered");
  const confirm = app.security.querySelector("#confirm-recovery");
  confirm.form.requestSubmit();
  check(!app.security.busy && !app.store, "setup waits until the person says the key is saved");
  confirm.checked = true;
  const started = performance.now();
  confirm.form.requestSubmit();
  await wait(() => Boolean(app.store) && !app.busy && !app.security.busy);
  const setupMs = performance.now() - started;
  {
    const { manifestRecoveryLabels } = await import("/security/key-label.js");
    check((await manifestRecoveryLabels(app.vault.manifest))[0] === setupLabel, "the label shown at setup is the new key's label");
  }
  check(
    app.security.phase === "unlocked" && app.state.items.length === 0,
    "setup verifies root and empty replay before unlock",
  );
  app.compose.input.value = "Synthetic protected household secret";
  // One canonical event: capture without a planning date.
  app.compose.plan.value = "none";
  app.compose.form.requestSubmit();
  await wait(() => !app.busy);
  check(
    app.state.items.length === 1 &&
      app.state.items[0].text === "Synthetic protected household secret",
    "unlocked household command works",
  );
  app.compose.input.value = "Unsaved private draft";
  app.compose.input.dispatchEvent(new Event("input"));
  check(
    sessionStorage.getItem("kin.compose.draft") === null,
    "draft is never persisted in plaintext",
  );
  const raw = await new Promise((resolve, reject) => {
    const q = indexedDB.open("kin");
    q.onsuccess = () => {
      const db = q.result;
      const tx = db.transaction("events");
      const r = tx.objectStore("events").getAll();
      tx.oncomplete = () => {
        db.close();
        resolve(r.result);
      };
      tx.onabort = () => reject(tx.error);
    };
    q.onerror = () => reject(q.error);
  });
  check(
    raw.length === 1 &&
      raw[0].protected_version === 1 &&
      !JSON.stringify(raw).includes("Synthetic") &&
      !Object.hasOwn(raw[0], "encoded_event"),
    "browser IDB has ciphertext only",
  );
  const oldStore = app.store;
  app.ctx.session.lockHousehold();
  check(
    app.state === null &&
      app.engine === null &&
      app.store === null &&
      app.vault === null,
    "lock drops projection and key capabilities",
  );
  check(
    !document.body.textContent.includes("Synthetic protected") &&
      !document.body.textContent.includes("Unsaved private"),
    "lock clears household and draft DOM",
  );
  let denied = false;
  try {
    await oldStore.loadEvents();
  } catch {
    denied = true;
  }
  check(denied, "old store capability rejected after lock");
  check(
    app.security.heading.textContent === "Welcome back" &&
      app.security.querySelector(".recovery-form")?.hidden === false &&
      ![...app.security.querySelectorAll("button")].some((button) => button.textContent.startsWith("Unlock with passkey")),
    "without a passkey the lock screen shows recovery directly and no passkey button",
  );
  {
    // #578/#579: the unlock form asks for the entry this device saved and says which one to pick.
    const unlockAccount = () => app.security.querySelector('.recovery-form input[autocomplete="username"]');
    // The lock screen no longer shows the key, so wait() may print the page.
    await wait(() => unlockAccount()?.value === setupEntry);
    const entryLine = app.security.querySelector("#recovery-unlock-entry");
    check(unlockAccount()?.value === setupEntry && entryLine?.textContent === `Use the saved entry ending ${setupLabel}.` && !entryLine.hidden &&
      app.security.querySelector("#recovery-unlock").getAttribute("aria-describedby").includes("recovery-unlock-entry"),
      "the unlock form requests this device's entry and names it under the field");
    check(app.security.querySelector('label[for="recovery-unlock"]')?.textContent === "Backup key for this device" &&
      app.security.querySelector("#recovery-unlock-help")?.textContent.includes("Each device has its own") &&
      [...app.security.querySelectorAll("button")].some((button) => button.textContent === "Unlock with backup key"),
      "the unlock screen calls it the backup key for this device");
    const remembered = localStorage.getItem(BACKUP_KEY_ENTRY_KEY) ?? "";
    check(remembered.includes(setupLabel) && !remembered.includes(recovery), "only the entry name is remembered, never the key");
  }
  {
    // Presentation-only probe: a synthetic PRF wrapper must switch the lock
    // screen to passkey-first without any unlock attempt or persistence.
    const realManifest = app.security.manifest;
    app.security.manifest = { ...realManifest, wrappers: [...realManifest.wrappers,
      { version: 1, id: "ab".repeat(16), type: "prf", credentialId: "AQID", prfSalt: "AAAA", sealed: {} }] };
    app.security.render();
    const primary = app.security.querySelector("button.primary-action");
    const form = app.security.querySelector(".recovery-form");
    check(primary?.textContent === "Unlock with passkey" && form?.hidden === true &&
      Boolean(app.security.querySelector("#recovery-unlock")),
      "a saved passkey makes passkey unlock primary and recovery secondary");
    [...app.security.querySelectorAll("button")].find((button) => button.textContent === "Use backup key").click();
    check(form.hidden === false && document.activeElement === app.security.querySelector("#recovery-unlock"),
      "recovery stays one tap away and receives focus");
    app.security.manifest = realManifest;
    app.security.recoveryExpanded = false;
    app.security.render();
    check(app.security.querySelector(".recovery-form")?.hidden === false, "lock screen returns to recovery-first without a wrapper");
  }
  await app.security.run(() => app.security.unlockRecovery("f".repeat(64)));
  check(
    app.state === null &&
      app.store === null &&
      app.security.alert.textContent.includes("could not unlock"),
    "wrong recovery stays locked",
  );
  const unlockStart = performance.now();
  await app.security.run(() => app.security.unlockRecovery(recovery));
  check(
    app.state?.items.length === 1 && !app.busy,
    "recovery unlock replays saved ciphertext",
  );
  const unlockMs = performance.now() - unlockStart;
  const { exportHouseholdArchive, validateHouseholdArchive: validateHouseholdArchiveForLabel } = await import("/security/archive.js");
  const portableMembership = [
    { memberId: "11111111111111111111111111111111", memberKind: "adult", status: "active" },
    { memberId: "22222222222222222222222222222222", memberKind: "limited", status: "removed" },
    { memberId: "33333333333333333333333333333333", memberKind: "temporary", status: "active", expiresAt: Date.now() + 60_000 },
    { memberId: "44444444444444444444444444444444", memberKind: "temporary", status: "expired", expiresAt: Date.now() - 60_000 },
    { memberId: "55555555555555555555555555555555", memberKind: "temporary", status: "removed", expiresAt: Date.now() - 60_000 },
    { memberId: "66666666666666666666666666666666", memberKind: "temporary", status: "active", expiresAt: Date.now() - 60_000 },
  ];
  const archive = await exportHouseholdArchive({
    store: app.store,
    engine: app.engine,
    vault: app.vault,
    portableMembership,
  });
  check(
    archive instanceof Uint8Array && archive.length > 100,
    "encrypted archive export available",
  );
  // #160: the header names the recovery key label that opens the export,
  // the same label Settings shows and the download file name carries.
  {
    const { describeHouseholdArchive } = await import("/security/archive.js");
    const { exportFileName, manifestRecoveryLabels } = await import("/security/key-label.js");
    const described = await describeHouseholdArchive(archive, app.engine);
    const current = await manifestRecoveryLabels(app.vault.manifest);
    check(
      described.labels.length === 1 && described.labels[0] === current[0] && /^K-[0-9A-F]{4}$/.test(current[0]) &&
        exportFileName(described.exportedAt, described.labels[0]) === `kin-${described.exportedAt.slice(0, 10)}-${current[0]}.kin`,
      "export header and file name carry the current recovery key label",
    );
    let mismatch = "";
    try {
      await validateHouseholdArchiveForLabel({ bytes: archive, recoverySecret: "f".repeat(64), engine: app.engine, vault: app.vault });
    } catch (error) { mismatch = error.message; }
    check(mismatch.includes(current[0]), "a wrong key for an export names the label that opens it");
  }
  const parsed = app.engine.decodeArchive(archive);
  check(
    !new TextDecoder().decode(archive).includes("Synthetic"),
    "archive body preserves encryption",
  );
  const {
    deserializeProtectedValue,
    serializeProtectedValue,
    fromBase64Url,
    LocalVault,
  } = await import("/security/local-vault.js");
  const { readArchive } = await import("/security/archive-stream.js");
  // Opens a package-format-3 export with its recovery key, as restore does,
  // into the historical snapshot shape (events carry sequence and bytes).
  const openExport = async (bytes) => {
    const layout = app.engine.archiveLayout(bytes);
    const exportHeader = deserializeProtectedValue(bytes.slice(16, 16 + layout.metadataLength));
    const exportVault = await LocalVault.unlock(exportHeader.manifest, recovery);
    try {
      const aad = serializeProtectedValue({ archiveVersion: exportHeader.archiveVersion,
        manifest: exportHeader.manifest, packageManifest: exportHeader.packageManifest });
      const key = await exportVault.archiveStreamKey(fromBase64Url(exportHeader.protection.salt), aad);
      const contents = { events: [], local_context: [], attachments: [] };
      await readArchive({
        bytes, offset: 16 + layout.metadataLength, length: layout.ciphertextLength, key,
        noncePrefix: fromBase64Url(exportHeader.protection.noncePrefix), vaultId: exportHeader.protection.vaultId,
        attachmentCount: exportHeader.packageManifest.attachmentCount, eventCount: exportHeader.packageManifest.eventCount,
        onContext: (row) => contents.local_context.push(row),
        onAttachment: (row) => contents.attachments.push(row),
        onEvents: (sequences, records) => records.forEach((record, index) =>
          contents.events.push({ local_sequence: sequences[index], encoded_event: record.slice() })),
        check: async () => {},
      });
      return { header: exportHeader, snapshot: contents };
    } finally { exportVault.lock(); }
  };
  const { header, snapshot } = await openExport(archive);
  const secondArchive = await exportHouseholdArchive({
    store: app.store,
    engine: app.engine,
    vault: app.vault,
    portableMembership,
  });
  const { snapshot: secondSnapshot } = await openExport(secondArchive);
  check(
    snapshot.events.length === 1 &&
      header.archiveVersion === 3 &&
      header.packageManifest.packageFormatVersion === 3 &&
      header.packageManifest.eventCount === 1 &&
      JSON.stringify(snapshot.local_context[0].portable_membership) === JSON.stringify(portableMembership) &&
      JSON.stringify(Array.from(snapshot.events[0].encoded_event)) ===
        JSON.stringify(Array.from(secondSnapshot.events[0].encoded_event)),
    "archive recovery round trip and deterministic canonical content",
  );
  // A package-format-2 export, as v0.47 wrote it, from the same household.
  const recoveryVault = await LocalVault.unlock(header.manifest, recovery);
  const wholeSnapshot = await app.store.snapshotForArchive({ portableMembership });
  const packageTwoManifest = { ...header.packageManifest, packageFormatVersion: 2 };
  const packageTwoAad = serializeProtectedValue({ archiveVersion: 2, manifest: header.manifest, packageManifest: packageTwoManifest });
  const { ciphertext: packageTwoCiphertext, ...packageTwoProtection } = await recoveryVault.sealArchive(
    { packageFormatVersion: 2, snapshot: wholeSnapshot }, packageTwoAad, { rawCiphertext: true });
  const packageTwoArchive = app.engine.encodeArchive(
    serializeProtectedValue({ archiveVersion: 2, manifest: header.manifest, packageManifest: packageTwoManifest, protection: packageTwoProtection }),
    packageTwoCiphertext,
  );
  denied = false;
  try {
    await exportHouseholdArchive({ store: app.store, engine: app.engine, vault: app.vault,
      portableMembership: [{ memberId: "55555555555555555555555555555555", memberKind: "future-kind", status: "active" }] });
  } catch { denied = true; }
  check(denied, "unknown explicit member kinds fail closed during export");
  const legacySnapshot = wholeSnapshot;
  const legacyAad = serializeProtectedValue({
    archiveVersion: 1,
    manifest: header.manifest,
  });
  const legacyEnvelope = await recoveryVault.sealArchive(
    legacySnapshot,
    legacyAad,
    { rawCiphertext: true },
  );
  const { ciphertext: legacyCiphertext, ...legacyProtection } = legacyEnvelope;
  const legacyArchive = app.engine.encodeArchive(
    serializeProtectedValue({
      archiveVersion: 1,
      manifest: header.manifest,
      protection: legacyProtection,
    }),
    legacyCiphertext,
  );
  // A different (still valid) manifest derives a different key, so the
  // segments no longer open.
  const tamperedHeader = { ...header, packageManifest: { ...header.packageManifest, exportedAt: new Date(0).toISOString() } };
  const { validateHouseholdArchive: validateForTamper } = await import("/security/archive.js");
  denied = false;
  try {
    await validateForTamper({
      bytes: app.engine.encodeArchive(serializeProtectedValue(tamperedHeader), parsed.ciphertext),
      recoverySecret: recovery, engine: app.engine, vault: app.vault,
    });
  } catch (error) {
    denied = error.message.includes("damaged");
  }
  check(denied, "archive metadata tampering rejected");
  recoveryVault.lock();
  await navigator.serviceWorker.ready;
  const keys = await caches.keys();
  const cache = await caches.open(
    keys.find((key) => key.startsWith("kin-static-")),
  );
  const requests = await cache.keys();
  check(
    requests.length > 15 &&
      requests.every(
        (request) =>
          !new URL(request.url).pathname.startsWith("/api/") &&
          !new URL(request.url).search,
      ),
    "offline cache contains static shell only",
  );
  // Destroy only these test-owned databases in the isolated temporary profile.
  // Restore into a separately created root to exercise actual portable recovery.
  const sourceRecovery = recovery;
  app.ctx.session.lockHousehold();
  for (const name of ["kin", "kin-crypto-keys"]) {
    await new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase(name);
      request.onsuccess = resolve;
      request.onerror = () => reject(request.error);
      request.onblocked = () =>
        reject(Error("Test archive restore database is still open"));
    });
  }
  await app.security.initialize();
  app.security.showSetup();
  recovery = app.security.querySelector(".recovery-key").textContent;
  const targetInput = app.security.querySelector("#confirm-recovery");
  targetInput.checked = true;
  targetInput.form.requestSubmit();
  await wait(() => app.vault?.vaultId && app.state && !app.security.busy && !app.busy);
  check(
    app.vault.vaultId !== header.manifest.vaultId &&
      app.state.items.length === 0,
    "restore target has an independently established empty protected household",
  );
  const { importHouseholdArchive } = await import("/security/archive.js");
  const {
    validateHouseholdArchive,
    discardValidatedHouseholdArchive,
  } = await import("/security/archive.js");
  denied = false;
  try {
    await validateHouseholdArchive({
      bytes: legacyArchive,
      recoverySecret: sourceRecovery,
      engine: app.engine,
      vault: app.vault,
    });
  } catch { denied = true; }
  check(
    denied && (await app.store.loadEvents()).length === 0,
    "a development-era package-v1 export is refused without modifying the target",
  );
  const packageTwo = await validateHouseholdArchive({
    bytes: packageTwoArchive,
    recoverySecret: sourceRecovery,
    engine: app.engine,
    vault: app.vault,
  });
  discardValidatedHouseholdArchive(packageTwo.stage);
  check(
    packageTwo.packageFormatVersion === 2 && packageTwo.eventCount === 1 &&
      (await app.store.loadEvents()).length === 0,
    "a package-v2 export from v0.47 still validates for restore",
  );
  const corrupted = archive.slice();
  corrupted[corrupted.length - 1] ^= 1;
  denied = false;
  try {
    await importHouseholdArchive({
      bytes: corrupted,
      recoverySecret: sourceRecovery,
      engine: app.engine,
      vault: app.vault,
    });
  } catch {
    denied = true;
  }
  check(
    denied && (await app.store.loadEvents()).length === 0,
    "corrupt portable archive rejects before any target history mutation",
  );
  const unsupportedHeader = {
    ...header,
    packageManifest: { ...header.packageManifest, packageFormatVersion: 99 },
  };
  denied = false;
  try {
    const unsupportedMetadata = serializeProtectedValue(unsupportedHeader);
    const unsupportedArchive = app.engine.encodeArchive(unsupportedMetadata, parsed.ciphertext);
    await importHouseholdArchive({
      bytes: unsupportedArchive,
      recoverySecret: sourceRecovery,
      engine: app.engine,
      vault: app.vault,
    });
  } catch {
    denied = true;
  }
  check(
    denied && (await app.store.loadEvents()).length === 0,
    "unsupported package versions reject before any target history mutation",
  );
  for (const stage of ["unlock", "decrypt"]) {
    const unlockBefore = LocalVault.unlock;
    const openBefore = LocalVault.prototype.archiveStreamKey;
    let releaseSource,
      sourceReady,
      sourceVault,
      openCalls = 0;
    const holdSource = new Promise((resolve) => (releaseSource = resolve));
    const reachedSource = new Promise((resolve) => (sourceReady = resolve));
    LocalVault.unlock = async (...args) => {
      const value = await unlockBefore.call(LocalVault, ...args);
      if (args[0].vaultId === header.manifest.vaultId) {
        sourceVault = value;
        if (stage === "unlock") {
          sourceReady();
          await holdSource;
        }
      }
      return value;
    };
    LocalVault.prototype.archiveStreamKey = async function (...args) {
      if (this.vaultId !== header.manifest.vaultId)
        return openBefore.apply(this, args);
      openCalls++;
      const plaintext = await openBefore.apply(this, args);
      if (stage === "decrypt") {
        sourceReady();
        await holdSource;
      }
      return plaintext;
    };
    try {
      const pendingImport = importHouseholdArchive({
        bytes: archive,
        recoverySecret: sourceRecovery,
        engine: app.engine,
        vault: app.vault,
      }).then(
        () => ({ accepted: true }),
        (error) => ({ accepted: false, error }),
      );
      await reachedSource;
      check(
        (await app.store.loadEvents()).length === 0,
        `archive ${stage} pending leaves target untouched`,
      );
      app.ctx.session.lockHousehold();
      releaseSource();
      const outcome = await pendingImport;
      check(
        !outcome.accepted && app.state === null && app.vault === null,
        `target lock cancels pending archive ${stage} without projection`,
      );
      check(
        sourceVault.locked && sourceVault.root === null,
        `cancelled archive ${stage} releases its source key capability`,
      );
      if (stage === "unlock")
        check(
          openCalls === 0,
          "target lock during source unlock prevents starting archive decryption",
        );
    } finally {
      releaseSource();
      LocalVault.unlock = unlockBefore;
      LocalVault.prototype.archiveStreamKey = openBefore;
      sourceVault?.lock();
    }
    await app.security.run(() => app.security.unlockRecovery(recovery));
    check(
      app.state?.items.length === 0 &&
        (await app.store.loadEvents()).length === 0,
      `cancelled archive ${stage} retains original recoverable empty target`,
    );
  }
  location.hash = "#household/privacy";
  app.ctx.navigation.showPageFromLocation();
  app.security.showRestore();
  const restoreFile = app.security.querySelector("#archive-file");
  const transfer = new DataTransfer();
  transfer.items.add(new File([archive], "household.kin", { type: "application/octet-stream" }));
  restoreFile.files = transfer.files;
  app.security.querySelector("#archive-recovery").value = sourceRecovery;
  restoreFile.form.requestSubmit();
  await wait(() => !app.security.busy && app.security.querySelector("#restore-confirm"));
  const confirmation = app.security.querySelector("#restore-confirm");
  check((await app.store.loadEvents()).length === 0,
    "validated restore is staged without mutating household history");
  check(document.activeElement === confirmation,
    "validation moves keyboard focus to the restore confirmation");
  confirmation.click();
  await wait(() => app.state?.items?.[0]?.text === "Synthetic protected household secret" && !app.security.busy);
  const imported = { eventCount: (await app.store.loadEvents()).length };
  await app.ctx.session.initialize();
  check(
    imported.eventCount === 1 &&
      app.state.items[0].text === "Synthetic protected household secret" &&
      app.security.message.textContent.includes("restored on this device"),
    "confirmed restore imports and renders exact recovered history with a trust notice",
  );
  const restored = await app.store.loadEvents();
  check(
    Array.from(restored[0].encoded_event).join(",") ===
      Array.from(snapshot.events[0].encoded_event).join(","),
    "archive restoration preserves canonical source bytes",
  );
  const restoredPortableSnapshot = await app.store.snapshotForArchive();
  check(
    JSON.stringify(restoredPortableSnapshot.local_context[0].portable_membership) ===
      JSON.stringify(portableMembership),
    "restored membership history preserves every authoritative status and absolute Temporary expiry",
  );
  const restoredHouseholdId = Array.from(restoredPortableSnapshot.local_context[0].sync_household_id,
    (byte) => byte.toString(16).padStart(2, "0")).join("");
  const restoredIdentity = { householdId: restoredHouseholdId, memberId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", deviceId: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" };
  denied = false;
  try {
    await app.store.initializeSync({ identity: { ...restoredIdentity, householdId: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" },
      serverStatus: { currentEpoch: 1, pendingEpoch: null, rotationPending: false } });
  } catch (error) { denied = error.message.includes("belongs to another household"); }
  check(denied && !(await app.store.getSyncState()),
    "an approved identity for another household cannot attach restored history");
  await app.store.initializeSync({ identity: restoredIdentity,
    serverStatus: { currentEpoch: 1, pendingEpoch: null, rotationPending: false },
    legacyBindingEnvelope: { version: 1, ciphertext: "authorized migration fixture" } });
  check((await app.store.getSyncState())?.householdId === restoredHouseholdId,
    "restored history can initialize sync only for its matching approved household identity");
  const importedEventId = Array.from(restored[0].event_id,
    (byte) => byte.toString(16).padStart(2, "0")).join("");
  await app.store.commitRemoteBatch({
    received: [{ encodedEvent: restored[0].encoded_event, sourceDeviceId: "cccccccccccccccccccccccccccccccc", sourceDeviceSequence: 7 }],
    nextCursor: "AAAAAAAAAAE", engine: app.engine,
  });
  const duplicateOutbox = await app.store.getRemoteDuplicateOutbox();
  check(duplicateOutbox.length === 1 && duplicateOutbox[0].event_id === importedEventId,
    "stale export events already on the relay are identified for deduplicated catch-up");
  await app.store.storeOutboxEnvelope(importedEventId, { eventId: importedEventId, ciphertext: "migration fixture" }, 1);
  await app.store.markOutboxAccepted(importedEventId, "AAAAAAAAAAE");
  await app.store.append({ type: "add", text: "New change after restore", classification: "need" }, app.engine);
  await app.store.compactArchiveOutboxSequences();
  const compactedOutbox = await app.store.getPendingOutbox();
  check(compactedOutbox.length === 1 && compactedOutbox[0].deviceSequence === 1 &&
      (await app.store.getSyncState()).nextDeviceSequence === 2,
    "stale event deduplication keeps new local changes on a contiguous device sequence");
  const sameHouseholdRestore = await importHouseholdArchive({
    bytes: archive,
    recoverySecret: sourceRecovery,
    engine: app.engine,
    vault: app.vault,
    store: app.store,
  });
  check(
    sameHouseholdRestore.alreadyPresent && (await app.store.loadEvents()).length === 2,
    "same-household restore is idempotent and does not duplicate canonical events",
  );

  // This is a second same-origin browsing context with its own module state.
  const peer = window.open(location.origin, "kin-security-peer");
  check(Boolean(peer), "peer tab can open");
  try {
    await wait(
      () =>
        peer.document.querySelector("kin-app")?.security?.manifest &&
        !peer.document.querySelector("kin-app").starting,
    );
    const peerApp = peer.document.querySelector("kin-app");
    check(
      peerApp.state === null &&
        peerApp.engine === null &&
        peerApp.vault === null,
      "second tab starts locked despite existing ciphertext",
    );
    await peerApp.security.run(() => peerApp.security.unlockRecovery(recovery));
    check(
      peerApp.state?.items.length === 2,
      "second tab independently unlocks same canonical history",
    );
    const peerStore = peerApp.store,
      peerEngine = peerApp.engine;
    const peerVault = peerApp.vault;
    const originalPeerOpen = peerVault.open.bind(peerVault);
    let releasePeerRead, reachedPeerRead;
    const peerReadGate = new Promise((resolve) => { releasePeerRead = resolve; });
    const peerReadStarted = new Promise((resolve) => { reachedPeerRead = resolve; });
    peerVault.open = async (...args) => {
      const value = await originalPeerOpen(...args);
      reachedPeerRead();
      await peerReadGate;
      return value;
    };
    // The session arena serves reads without decrypting; force a full read so
    // this native transaction really waits on Web Crypto.
    peerStore.arena.reset(null);
    const peerRead = peerStore.loadEvents().then(() => false, () => true);
    try {
      await peerReadStarted;
      app.ctx.session.lockHousehold();
      await wait(() => peerApp.state === null && peerApp.vault === null);
      await app.lockBarrier;
      check(await peerRead, "peer lock intent aborts a crypto-held read before the durable epoch write can deadlock");
      check(peerVault.locked, "peer lock disposes the key during a native read transaction");
    } finally { releasePeerRead(); peerVault.open = originalPeerOpen; }
    check(
      peerApp.store === null && peerApp.engine === null && peerApp.main.hidden,
      "lock broadcast revokes peer capabilities",
    );
    check(
      !peer.document.body.textContent.includes("Synthetic protected"),
      "peer lock removes plaintext DOM",
    );
    denied = false;
    try {
      await peerStore.loadEvents();
    } catch {
      denied = true;
    }
    check(denied, "peer stale storage capability rejected after lock");
    denied = false;
    try {
      peerEngine.applyEvents([], 1234, null, 20261003);
    } catch {
      denied = true;
    }
    check(denied, "peer stale engine cannot construct a projection after lock");
  } finally {
    peer?.close();
  }

  // Hold only the asynchronous crypto completion boundary to exercise a real
  // cancellation race; the production authentication/persistence path is used.
  const originalUnlock = LocalVault.unlock;
  let release, reached, pendingVault;
  const gate = new Promise((resolve) => (release = resolve));
  const obtained = new Promise((resolve) => (reached = resolve));
  LocalVault.unlock = async (...args) => {
    pendingVault = await originalUnlock.call(LocalVault, ...args);
    reached();
    await gate;
    return pendingVault;
  };
  try {
    const pending = app.security.run(() =>
      app.security.unlockRecovery(recovery),
    );
    await obtained;
    check(
      app.state === null && app.engine === null,
      "unlock does not project before crypto completion",
    );
    app.ctx.session.lockHousehold();
    release();
    await pending;
    check(
      app.state === null && app.engine === null && app.vault === null,
      "lock during pending unlock prevents late projection",
    );
    check(
      pendingVault.locked && pendingVault.root === null,
      "cancelled unlock discards the completed key capability",
    );
  } finally {
    release();
    LocalVault.unlock = originalUnlock;
    pendingVault?.lock();
  }

  // Capability detection is isolated from authenticator availability; this is
  // explicitly unsupported-PRF coverage, not a claim of physical PRF testing.
  const descriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "PublicKeyCredential",
  );
  try {
    Object.defineProperty(globalThis, "PublicKeyCredential", {
      configurable: true,
      value: undefined,
    });
    await app.security.run(() =>
      app.security.unlockPasskey({ id: "unavailable" }),
    );
    check(
      app.state === null &&
        app.security.alert.textContent.includes("backup key"),
      "unsupported secure credential path stays locked with explicit recovery",
    );
    check(
      Boolean(app.security.querySelector("#recovery-unlock")),
      "unsupported PRF retains an accessible recovery control",
    );
  } finally {
    if (descriptor)
      Object.defineProperty(globalThis, "PublicKeyCredential", descriptor);
    else delete globalThis.PublicKeyCredential;
  }
  await app.security.run(() => app.security.unlockRecovery(recovery));
  check(
    app.state?.items.length === 2,
    "normal unlock still works after cancelled and unsupported paths: " + JSON.stringify({phase:app.security.phase,error:app.security.alert?.textContent,status:app.status?.textContent,items:app.state?.items.length}),
  );
  return {
    checks,
    recovery,
    timings: {
      emptySetupMs: setupMs,
      oneEventUnlockAndReplayMs: unlockMs,
      archiveBytes: archive.length,
    },
  };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const executable = process.argv[2];
  assert.ok(
    executable,
    "Usage: node scripts/security-ui-regression.mjs <browser executable> ",
  );
  const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../web");
  const profile = await mkdtemp(join(tmpdir(), "kin-security-ui-"));
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url, "http://localhost").pathname;
    if (pathname === "/api/status") {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ identity: null, claim: null }));
      return;
    }
    const path = resolve(
      webRoot,
      `.${pathname === "/" ? "/index.html" : pathname}`,
    );
    if (!path.startsWith(webRoot + sep)) {
      response.writeHead(403).end();
      return;
    }
    try {
      response.setHeader(
        "Content-Type",
        {
          ".html": "text/html",
          ".js": "text/javascript",
          ".css": "text/css",
          ".wasm": "application/wasm",
          ".webmanifest": "application/manifest+json",
          ".svg": "image/svg+xml",
        }[extname(path)] ?? "application/octet-stream",
      );
      response.end(await readFile(path));
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = spawn(
    executable,
    [
      "--headless=new",
      "--disable-gpu",
      "--disable-extensions",
      "--no-first-run",
      "--no-default-browser-check",
      "--edge-skip-compat-layer-relaunch",
      // The peer-tab check opens a window after long async work; the click
      // activation that would allow it can expire on a slow runner (#164).
      "--disable-popup-blocking",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    BROWSER_STDIO,
  );
  let socket;
  const loadTrace = createLoadTrace();
  try {
    const port = await waitForDevTools(browser, profile);
    // The tab opens on about:blank and loads Kin only once the load trace
    // (#594) is listening, so a first start that stalls can show why.
    const target = await fetch(
      `http://127.0.0.1:${port}/json/new?about:blank`,
      { method: "PUT" },
    ).then((response) => response.json());
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.onopen = resolve;
      socket.onerror = reject;
    });
    let id = 0;
    const pending = new Map();
    // Top-level navigations, reported if a step fails (#164): an unexpected
    // one is what destroys the execution context mid-check.
    const navigations = [];
    socket.onmessage = ({ data }) => {
      const message = JSON.parse(data);
      if (message.method) loadTrace.observe(message);
      if (message.method === "Page.frameNavigated" && !message.params.frame.parentId)
        navigations.push(`${new Date().toISOString()} ${message.params.frame.url}`);
      if (message.id) {
        const task = pending.get(message.id);
        pending.delete(message.id);
        message.error
          ? task.reject(Error(JSON.stringify(message.error)))
          : task.resolve(message.result);
      }
    };
    const send = (method, params) =>
      new Promise((resolve, reject) => {
        const next = ++id;
        pending.set(next, { resolve, reject });
        socket.send(JSON.stringify({ id: next, method, params }));
      });
    const client = {
      send,
      navigations,
      evaluate: async (expression) => {
        const result = await send("Runtime.evaluate", {
          expression,
          awaitPromise: true,
          returnByValue: true,
          userGesture: true,
        });
        assert.equal(
          result.exceptionDetails,
          undefined,
          JSON.stringify(result.exceptionDetails),
        );
        return result.result.value;
      },
    };
    for (const domain of ["Runtime", "Network"]) await send(`${domain}.enable`);
    // Worker starts, stops and version changes go into the load trace.
    await send("ServiceWorker.enable").catch(() => {});
    await applyRegressionDefaults(send);
    await send("Page.navigate", { url: origin });
    // Kin must have started before browserUiChecks waits inside the page: a
    // start-up guard reload during that one call would end it (#469).
    await waitForKinStart(client.evaluate, origin, { navigate: () => send("Page.navigate", { url: origin }) });
    await send("Page.enable");
    // A guard reload that recovered a lost module still gets its note (#594).
    await securityUiRegressions(client, { beforeExit: () => printAbortedModules(loadTrace) });
  } catch (error) {
    // Before the browser closes: what each page showed (#328), and how the
    // tab loaded Kin (#594).
    printLoadTrace(loadTrace);
    await captureFailure("security UI regression");
    throw error;
  } finally {
    printAbortedModules(loadTrace);
    if (socket) {
      const closed = new Promise((resolve) => socket.addEventListener("close", resolve, { once: true }));
      socket.close();
      await Promise.race([closed, delay(1_000)]);
    }
    if (process.platform === "win32" && browser.pid) {
      const killer = spawn("powershell.exe", ["-NoProfile", "-Command",
        "for ($attempt = 0; $attempt -lt 10; $attempt++) { $targets = Get-CimInstance Win32_Process -Filter \"Name = 'msedge.exe'\" | Where-Object { $_.CommandLine -like \"*$env:KIN_TEST_PROFILE*\" }; if (-not $targets) { break }; foreach ($target in $targets) { Stop-Process -Id $target.ProcessId -Force -ErrorAction SilentlyContinue }; Start-Sleep -Milliseconds 100 }"],
      { windowsHide: true, stdio: "ignore", env: { ...process.env, KIN_TEST_PROFILE: profile } });
      const [code] = await once(killer, "exit");
      if (code !== 0) console.warn(`Could not terminate Edge processes for the isolated test profile (PowerShell ${code}).`);
    } else browser.kill();
    if (browser.exitCode === null) await Promise.race([once(browser, "exit"), delay(2_000)]);
    browser.unref();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await delay(300);
    assert.ok(
      resolve(profile).startsWith(resolve(tmpdir()) + sep),
      "Refuse cleanup outside the test-profile directory",
    );
    await rm(profile, {
      recursive: true,
      force: true,
      maxRetries: 2,
      retryDelay: 100,
    }).catch((error) => {
      if (error.code !== "EBUSY") throw error;
      console.warn("Temporary Edge profile remained busy; the OS may remove it later.");
    });
  }
}
