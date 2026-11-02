// Real WebAuthn through a virtual authenticator and the production Kin server.
// https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/pdl/domains/WebAuthn.pdl
import { BROWSER_STDIO, waitForDevTools } from "./browser-launch.mjs";
import { applyRegressionDefaults, captureFailure, createLoadTrace, printAbortedModules, printLoadTrace, waitForKinStart } from "./cdp-page.mjs";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { createKinServer } from "../server/server.mjs";
import { DurableStore } from "../server/durable-store.mjs";

export async function passkeyRegressions(client, service, syncService) {
  await client.send("WebAuthn.enable", { enableUI: false });
  const { authenticatorId } = await client.send(
    "WebAuthn.addVirtualAuthenticator",
    {
      options: {
        protocol: "ctap2",
        ctap2Version: "ctap2_1",
        transport: "internal",
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
        hasPrf: true,
      },
    },
  );
  try {
    const setup = await client.evaluate(`(${setupPasskey.toString()})()`);
    const credentials = await client.send("WebAuthn.getCredentials", {
      authenticatorId,
    });
    assert.equal(credentials.credentials.length, 1);
    let checks = setup.checks + 1;
    if (setup.prfSupported) {
      checks += await client.evaluate(`(${lockScreenChecks.toString()})()`);
      checks += await client.evaluate(`(${unlockPasskey.toString()})(true)`);
      checks += await client.evaluate(`(${attachmentUiChecks.toString()})(${JSON.stringify(setup.recovery)})`);
      checks += await client.evaluate(`(${wrongPrfFailsClosed.toString()})()`);
      await client.send("WebAuthn.setResponseOverrideBits", {
        authenticatorId,
        isBadUV: true,
      });
      checks += await client.evaluate(`(${unlockPasskey.toString()})(false)`);
      await client.send("WebAuthn.setResponseOverrideBits", {
        authenticatorId,
        isBogusSignature: true,
      });
      checks += await client.evaluate(`(${unlockPasskey.toString()})(false)`);
      await client.send("WebAuthn.setResponseOverrideBits", {
        authenticatorId,
      });
      checks += await client.evaluate(`(${cancelPasskey.toString()})()`);
      checks += await client.evaluate(`(${unlockPasskey.toString()})(true)`);
    }
    checks += await client.evaluate(
      `(${recoverPasskey.toString()})(${JSON.stringify(setup.recovery)})`,
    );
    await client.evaluate(`(${prepareLeave.toString()})(${JSON.stringify(setup.recovery)})`);
    const departing = [...service.members.values()].find(member => member.active);
    const device = [...service.devices.values()].find(value => value.memberId === departing.id);
    const { sessionToken: token } = service.issueSession(departing.id, device.id);
    const invitation = service.createPairing(token);
    const claim = service.claimPairing({
      code: invitation.code,
      credential: { id: "synthetic-remaining-adult", publicKey: "synthetic-key", algorithm: -7 },
      deviceLabel: "Remaining adult fixture",
    });
    service.approvePairing(token, invitation.pairingId, claim.version);
    const remaining = service.activateClaim(claim.claimToken);
    syncService.enable(remaining.sessionToken);
    assert.throws(
      () => service.leaveHousehold(token, departing.id),
      (error) => error.code === "last_household_admin",
      "the server rejects departure by the last household admin",
    );
    assert.equal(service.members.get(departing.id).active, true);
    assert.equal(service.devices.get(device.id).revokedAt, null);
    service.setHouseholdAdmin(token, remaining.memberId, true, departing.id);
    assert.equal(
      service.householdView(token).members.find((member) => member.id === remaining.memberId)?.admin,
      true,
    );
    checks += 4;
    for (const override of [{ isBadUV: true }, { isBogusSignature: true }]) {
      await client.send("WebAuthn.setResponseOverrideBits", { authenticatorId, ...override });
      checks += await client.evaluate(`(${rejectedLeave.toString()})()`);
      assert.equal(service.members.get(departing.id).active, true);
      assert.equal(service.devices.get(device.id).revokedAt, null);
      assert.equal(syncService.status(remaining.sessionToken).rotationPending, false);
      checks += 3;
    }
    await client.send("WebAuthn.setResponseOverrideBits", { authenticatorId });
    await client.evaluate(`(${successfulLeave.toString()})()`);
    for (let attempt = 0; attempt < 400 && service.members.get(departing.id).active; attempt++)
      await delay(25);
    assert.equal(service.members.get(departing.id).active, false, "fresh verified passkey completes self-leave");
    assert.ok(service.devices.get(device.id).revokedAt);
    assert.equal([...service.sessions.values()].some(session => session.memberId === departing.id), false);
    assert.equal(syncService.status(remaining.sessionToken).pendingEpoch, 2);
    let leftLocally = false;
    for (let attempt = 0; attempt < 400 && !leftLocally; attempt++) {
      try {
        leftLocally = await client.evaluate("sessionStorage.getItem('kin-leave-check') === 'locked-after-passkey' && document.querySelector('kin-app')?.vault === null");
      } catch {
        // Successful leave navigates to the locked shell.
      }
      if (!leftLocally) await delay(25);
    }
    assert.ok(leftLocally, "successful component leave clears local authority only after verification");
    const status = await client.evaluate("fetch('/api/status').then(response => response.json()).then(value => value.identity)");
    assert.equal(status, null, "departing session and device cookies are cleared");
    checks += 6;
    console.log(
      `PASS ${checks} virtual-authenticator assertions; PRF ${setup.prfSupported ? "supported and exercised" : "unavailable; explicit recovery exercised"}`,
    );
  } finally {
    await client.send("WebAuthn.removeVirtualAuthenticator", {
      authenticatorId,
    });
    await client.send("WebAuthn.disable");
  }

  async function prepareLeave(recovery) {
    const app = document.querySelector("kin-app");
    await app.security.run(() => app.security.unlockRecovery(recovery));
    await app.household.load();
    if (!app.household.identity) throw new Error("Self-leave fixture needs its registered session.");
  }

  async function rejectedLeave() {
    const app = document.querySelector("kin-app");
    const controller = app.household;
    const originalConfirm = globalThis.confirm;
    globalThis.confirm = () => true;
    try {
      await controller.leave();
      if (!controller.identity || !app.vault || controller.querySelector(".household-message")?.getAttribute("role") !== "alert")
        throw new Error("Rejected passkey leave must preserve authority and surface an accessible error.");
      return 1;
    } finally {
      globalThis.confirm = originalConfirm;
    }
  }

  function successfulLeave() {
    const app = document.querySelector("kin-app");
    const controller = app.household;
    const originalGet = navigator.credentials.get.bind(navigator.credentials);
    const originalConfirm = globalThis.confirm;
    let asserted = false;
    navigator.credentials.get = async options => {
      const credential = await originalGet(options);
      asserted = true;
      return credential;
    };
    globalThis.confirm = () => true;
    app.addEventListener("kin:lock", () => {
      if (asserted && controller.identity === null && app.vault === null)
        sessionStorage.setItem("kin-leave-check", "locked-after-passkey");
    }, { once: true });
    void controller.leave().finally(() => {
      navigator.credentials.get = originalGet;
      globalThis.confirm = originalConfirm;
    });
  }
}

async function setupPasskey() {
  let checks = 0;
  const check = (value, message) => {
    if (!value) throw Error(message);
    checks++;
  };
  // 30 s: a fresh profile's first start (WASM, IndexedDB, service worker)
  // can take longer than 10 s on the Windows runner (#164).
  const wait = async (condition) => {
    for (let i = 0; i < 1200; i++) {
      if (condition()) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    const app = document.querySelector("kin-app");
    throw Error(`Passkey setup timed out (starting=${app?.starting}, heading=${Boolean(app?.security?.heading)}, phase=${app?.security?.phase})`);
  };
  await wait(
    () =>
      document.querySelector("kin-app")?.security?.heading &&
      !document.querySelector("kin-app").starting,
  );
  const app = document.querySelector("kin-app");
  check(app.state === null && app.vault === null, "setup starts locked");
  app.security.showSetup();
  const recovery = app.security.querySelector(".recovery-key").textContent;
  const input = app.security.querySelector("#confirm-recovery");
  input.checked = true;
  input.form.requestSubmit();
  await wait(() => app.store && !app.security.busy && !app.busy);
  app.compose.input.value = "Virtual passkey protected content";
  // One canonical event: capture without a planning date.
  app.compose.plan.value = "none";
  app.compose.form.requestSubmit();
  await wait(() => !app.busy);
  check(
    app.state.items.length === 1,
    "recovery-protected history exists before credential enrollment",
  );
  const persistedEvents = () =>
    new Promise((resolve, reject) => {
      const request = indexedDB.open("kin");
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const database = request.result;
        const transaction = database.transaction("events");
        const rows = transaction.objectStore("events").getAll();
        transaction.oncomplete = () => {
          database.close();
          resolve(JSON.stringify(rows.result));
        };
        transaction.onabort = () => {
          database.close();
          reject(transaction.error);
        };
      };
    });
  const ciphertextBefore = await persistedEvents();
  await app.household.register("bootstrap", {
    deviceLabel: "Synthetic virtual authenticator",
  });
  check(
    Boolean(app.household.identity),
    "WebAuthn registration verified by Kin: " + app.household.textContent,
  );
  // #577: once setup's device can reach the identity service, the unlocked
  // shell asks one calm question; "Turn on" runs the ordinary PRF enrolment.
  await wait(() => app.onboarding?.dataset.passkeyOffer === "setup" && !app.onboarding.hidden);
  check(
    app.security.justSetUp === true &&
      app.onboarding.textContent.includes("Unlock with your face, fingerprint or screen lock next time?"),
    "right after setup, passkey unlock is offered as the next step",
  );
  const turnOn = [...app.onboarding.querySelectorAll("button")].find((button) => button.textContent === "Turn on");
  const notNow = [...app.onboarding.querySelectorAll("button")].find((button) => button.textContent === "Not now");
  check(Boolean(turnOn) && Boolean(notNow) && turnOn.classList.contains("primary-action"),
    "the step offers Turn on and Not now");
  turnOn.click();
  await wait(() =>
    !app.security.busy &&
    (app.security.passkeyWrappers.length > 0 || Boolean(app.security.alert.textContent)) &&
    app.onboarding.dataset.passkeyOffer === undefined);
  check(
    (await persistedEvents()) === ciphertextBefore,
    "credential enrollment does not re-encrypt the canonical corpus",
  );
  const wrapper = app.security.manifest.wrappers.find(
    (value) => value.type === "prf",
  );
  if (!wrapper) {
    check(
      app.security.alert.textContent.includes("does not support secure PRF"),
      "unsupported PRF must be explicit: " + app.security.alert.textContent,
    );
    app.ctx.session.lockHousehold();
    check(
      app.vault === null && app.state === null,
      "login cookie alone cannot unlock local data",
    );
    return { checks, recovery, prfSupported: false };
  }
  check(
    wrapper.sealed && wrapper.credentialId && wrapper.prfSalt,
    "enrollment persists credential-associated root wrapper",
  );
  check(
    (await app.store.snapshotForArchive()).events.length === 1,
    "credential addition preserves corpus",
  );
  app.ctx.session.lockHousehold();
  check(
    app.vault === null &&
      app.state === null &&
      !document.body.textContent.includes("Virtual passkey protected content"),
    "registered logged-in credential still requires local unlock",
  );
  return { checks, recovery, prfSupported: true };
}

// The locked shell is passkey-first once a PRF wrapper exists: one primary
// passkey action, recovery behind a secondary control, no plaintext anywhere.
async function lockScreenChecks() {
  let checks = 0;
  const check = (value, message) => {
    if (!value) throw Error(message);
    checks++;
  };
  const app = document.querySelector("kin-app");
  check(app.vault === null && app.security.phase === "locked", "lock screen checks start locked");
  check(app.security.heading.textContent === "Welcome back", "returning users are welcomed back: " + app.security.heading.textContent);
  const primary = app.security.querySelector("button.primary-action");
  check(primary?.textContent === "Unlock with passkey", "passkey unlock is the primary action: " + primary?.textContent);
  const recoveryForm = app.security.querySelector(".recovery-form");
  check(recoveryForm?.hidden === true && Boolean(app.security.querySelector("#recovery-unlock")),
    "recovery entry stays available but secondary");
  const reveal = [...app.security.querySelectorAll("button")].find((button) => button.textContent === "Use backup key");
  check(Boolean(reveal), "the backup key is offered as a secondary action");
  reveal.click();
  check(!recoveryForm.hidden && document.activeElement === app.security.querySelector("#recovery-unlock"),
    "choosing recovery reveals and focuses the recovery form");
  const storage = [...Object.keys(localStorage), ...Object.keys(sessionStorage)]
    .map((key) => `${key}=${localStorage.getItem(key) ?? sessionStorage.getItem(key)}`).join("\n");
  check(!/[a-f0-9]{64}/i.test(storage) && !storage.includes("prfSalt"), "no secret material in web storage: " + storage);
  app.security.render();
  check(app.security.querySelector(".recovery-form").hidden === false,
    "a revealed recovery form stays revealed across re-render");
  app.security.recoveryExpanded = false;
  app.security.render();
  return checks;
}

// Photos attached through the real capture path render as thumbnails, open in
// the in-app viewer, survive lock/unlock, and report retrieval failures plainly.
async function attachmentUiChecks(recovery) {
  let checks = 0;
  const check = (value, message) => {
    if (!value) throw Error(message);
    checks++;
  };
  const wait = async (condition, label) => {
    for (let i = 0; i < 400; i++) {
      if (condition()) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    const app = document.querySelector("kin-app");
    throw Error(`Attachment UI wait timed out: ${label}; alert=${app?.alert?.textContent} status=${app?.status?.textContent}`);
  };
  const app = document.querySelector("kin-app");
  if (!app.vault) {
    await app.security.run(() => app.security.unlockRecovery(recovery));
    await wait(() => app.store && !app.busy, "unlock for attachments");
  }
  // Capture binds the file to this device's household identity, which the
  // household component loads asynchronously after unlock.
  await wait(() => Boolean(app.household?.identity), "household identity");
  location.hash = "#today";
  app.ctx.navigation.showPageFromLocation();
  app.compose.classification.value = "need";
  app.compose.plan.value = "today";
  app.compose.input.value = "Photo of the fridge";
  app.compose.form.requestSubmit();
  await wait(() => !app.busy && app.state.items.some((item) => item.text === "Photo of the fridge") && app.state.items.find((item) => item.text === "Photo of the fridge").planningDate !== null, "item add");
  const item = app.state.items.find((entry) => entry.text === "Photo of the fridge");
  check(item.classification === "need" && item.planningDate === app.ctx.navigation.currentCivilDate() && app.today.querySelector(`.item-text[data-item-id="${item.itemId}"]`),
    "Today capture creates a task planned for today that is visible on Today");
  // A real 2x2 PNG so the thumbnail pipeline decodes genuine image bytes.
  const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DwHwqY/j9/j8EBABRiB/GKvM3kAAAAAElFTkSuQmCC"), (c) => c.charCodeAt(0));
  const file = new File([png], "fridge.png", { type: "image/png" });
  const attach = app.today.querySelector(`.item-attach-button[data-item-id="${item.itemId}"]`);
  check(Boolean(attach) && !attach.closest("[hidden]") && app.selection === null,
    "Add photo is on the row itself; Details stays closed");
  // The tap must open the app-owned input synchronously (user activation) and
  // remember which item asked.
  let clicked = null;
  const nativeClick = HTMLInputElement.prototype.click;
  HTMLInputElement.prototype.click = function () { clicked = this; };
  try { attach.click(); } finally { HTMLInputElement.prototype.click = nativeClick; }
  check(clicked === app.attachmentInput && app.attachmentTarget?.parentId === item.itemId, "tapping Add photo opens the shared file input for that item");
  const transfer = new DataTransfer();
  transfer.items.add(file);
  app.attachmentInput.files = transfer.files;
  app.attachmentInput.dispatchEvent(new Event("change", { bubbles: true }));
  await wait(() => !app.busy && app.attachmentRows.some((row) => row.parentId === item.itemId), "attachment capture");
  const row = app.attachmentRows.find((entry) => entry.parentId === item.itemId);
  check(row.name === "fridge.png" && row.type === "image/png" && row.state === "queued", "captured row carries name, type and state: " + JSON.stringify(row));
  const rowStatus = () => [...app.today.querySelectorAll("kin-item")].find((node) => node.record?.itemId === item.itemId)?.querySelector(".attachment-status");
  check(rowStatus()?.textContent.startsWith("fridge.png is saved on this device") && rowStatus().dataset.phase === "saved",
    "the row confirms the save after re-rendering: " + rowStatus()?.textContent);
  const encryptedRow = (await app.store.loadAttachments()).find((entry) => entry.attachment_id === row.attachmentId);
  // This fixture registers a household but never enables sync, so the capture
  // takes the vault-sealed path; with a provisioned key it is household-key
  // ciphertext. Either way nothing is stored in the clear.
  check(Boolean(encryptedRow) && (encryptedRow.ciphertext ? encryptedRow.keyEpoch >= 1 && !encryptedRow.localSealed : Boolean(encryptedRow.localSealed)) && encryptedRow.state === "queued",
    "the stored record is protected at rest (household-key ciphertext or vault-sealed) and queued for sync");
  // Rows carry a compact thumbnail strip whose control names the file and its state.
  const thumb = () => app.today.querySelector(`kin-item .attachment-thumb[aria-label^="View fridge.png"]`);
  check(Boolean(thumb()) && !thumb().closest("[hidden]"), "an image thumbnail tile renders in the item's main area");
  const diagnose = () => JSON.stringify({
    tile: thumb()?.outerHTML.slice(0, 240),
    rect: thumb()?.getBoundingClientRect().toJSON(),
    viewport: [innerWidth, innerHeight],
    loader: typeof thumb()?.__kinLoadPreview,
    cache: app.attachmentPreviews ? [app.attachmentPreviews.entries.size, app.attachmentPreviews.pending.size, [...app.attachmentPreviews.entries.values()]] : null,
    provider: typeof app.today.previewProvider,
    itemProvider: typeof [...app.today.querySelectorAll("kin-item")].find((node) => node.record?.itemId === item.itemId)?.previewProvider,
  });
  // Thumbnails decode lazily: nothing is decrypted or decoded while the tile is
  // below the fold. Scrolling it into view is what triggers the preview.
  await new Promise((resolve) => setTimeout(resolve, 150));
  check(!thumb().querySelector("img").getAttribute("src") && app.attachmentPreviews.entries.size === 0 && app.attachmentPreviews.pending.size === 0,
    "an off-screen thumbnail is not decoded ahead of time: " + diagnose());
  thumb().scrollIntoView({ block: "center" });
  try {
    await wait(() => thumb()?.querySelector("img")?.src.startsWith("blob:"), "thumbnail decode");
  } catch (error) {
    throw Error(`${error.message}; ${diagnose()}`);
  }
  const img = thumb().querySelector("img");
  await wait(() => img.complete && img.naturalWidth > 0, "thumbnail load");
  check(img.naturalWidth <= 192 && img.naturalHeight <= 192 && img.alt === "", "thumbnail is bounded and decorative");
  check(getComputedStyle(thumb()).height.replace("px", "") >= 48, "thumbnail is a comfortable touch target");
  check(app.attachmentPreviews.peek(row.attachmentId)?.url === img.src, "preview object URL is cached per session");
  // Kind, size and state live on the full tile in the shared detail view.
  app.ctx.detail.openItemDetail(item.itemId);
  const metaText = app.detail.querySelector(`.attachment-tile .attachment-meta`)?.textContent ?? "";
  app.ctx.detail.closeItemDetail({ restoreFocus: false });
  check(metaText.includes("Photo") && metaText.includes("B"), "detail tile shows kind and size: " + metaText);
  check(thumb()?.getAttribute("aria-label").includes("Photo"), "the row thumbnail names the file kind for assistive technology");
  thumb().click();
  await wait(() => app.viewer.open, "viewer open");
  check(app.viewer.viewerImage.src.startsWith("blob:") && app.viewer.viewerTitle.textContent === "fridge.png",
    "tapping the thumbnail opens the full image with its name");
  check(document.activeElement === app.viewer.querySelector(".attachment-viewer-close"), "viewer focuses its close control");
  const viewerUrl = app.viewerUrl;
  app.viewer.querySelector(".attachment-viewer-close").click();
  // The dialog's close event is delivered asynchronously; release follows it.
  await wait(() => !app.viewer.open && app.viewerUrl === null, "viewer close");
  check(!app.viewer.viewerImage.getAttribute("src"), "closing the viewer releases its object URL");
  let revoked = false;
  try { await fetch(viewerUrl); } catch { revoked = true; }
  check(revoked, "the viewer blob URL is revoked after close");
  check(document.activeElement === thumb(), "closing the viewer returns focus to the thumbnail");
  const pdf = new File([new TextEncoder().encode("%PDF-1.4\n% synthetic\n%%EOF")], "warranty.pdf", { type: "application/pdf" });
  app.dispatchEvent(new CustomEvent("kin:add-attachment", { detail: { file: pdf, parentKind: "item", parentId: item.itemId }, bubbles: true }));
  await wait(() => !app.busy && app.attachmentRows.filter((entry) => entry.parentId === item.itemId).length === 2, "pdf capture");
  const pdfRow = [...app.today.querySelectorAll("kin-item .attachment-tile-document")].find((tile) => tile.querySelector("button")?.getAttribute("aria-label")?.startsWith("Open warranty.pdf"));
  check(Boolean(pdfRow) && !pdfRow.querySelector(".attachment-thumb") && pdfRow.querySelector("button").getAttribute("aria-label").includes("PDF"),
    "documents render as a recognizable compact control on the row, named with their kind");
  app.ctx.detail.openItemDetail(item.itemId);
  const pdfTile = [...app.detail.querySelectorAll(".attachment-tile")].find((tile) => tile.textContent.includes("warranty.pdf"));
  check(pdfTile?.classList.contains("attachment-tile-document") && pdfTile.querySelector(".attachment-meta").textContent.includes("PDF") &&
    pdfTile.querySelector('button[aria-label="Open warranty.pdf"]') && pdfTile.querySelector('button[aria-label="Save warranty.pdf"]') &&
    !pdfTile.querySelector(".attachment-thumb"), "documents render as a recognizable tile with Open and Save in the detail view");
  app.ctx.detail.closeItemDetail({ restoreFocus: false });
  app.ctx.status.clearAlert();
  await app.ctx.attachments.handleViewAttachment({ detail: { attachmentId: "00".repeat(16), parentKind: "item", parentId: item.itemId } });
  check(app.alert.textContent === "We couldn't open this attachment. Your existing household information hasn't been deleted." && !app.viewer.open,
    "a failed retrieval is explained without claiming data loss");
  app.ctx.status.clearAlert();
  app.ctx.session.lockHousehold();
  check(app.attachmentPreviews === null && !app.viewer.open, "locking drops every cached preview");
  let previewRevoked = false;
  try { await fetch(img.src); } catch { previewRevoked = true; }
  check(previewRevoked, "thumbnail object URLs are revoked on lock");
  await app.security.run(() => app.security.unlockRecovery(recovery));
  await wait(() => app.store && !app.busy && app.attachmentRows.some((entry) => entry.parentId === item.itemId), "re-unlock");
  location.hash = "#today";
  app.ctx.navigation.showPageFromLocation();
  await wait(() => Boolean(thumb()), "tile after unlock");
  thumb().scrollIntoView({ block: "center" });
  await wait(() => thumb()?.querySelector("img")?.src.startsWith("blob:"), "thumbnail after unlock");
  check(thumb().querySelector("img").src !== img.src, "a fresh session derives a fresh preview rather than reusing a revoked one");
  app.ctx.session.lockHousehold();
  return checks;
}

async function unlockPasskey(success) {
  const app = document.querySelector("kin-app");
  const wrapper = app.security.manifest.wrappers.find(
    (value) => value.type === "prf",
  );
  await app.security.run(() => app.security.unlockPasskey(wrapper));
  if (success) {
    if (app.state?.items[0]?.text !== "Virtual passkey protected content")
      throw Error(
        "PRF assertion failed to unlock: " + app.security.alert.textContent,
      );
    if (!app.vault || app.security.phase !== "unlocked")
      throw Error("PRF unlock lacks key capability");
    app.ctx.session.lockHousehold();
    return 2;
  }
  if (app.state !== null || app.vault !== null || app.engine !== null)
    throw Error("Bad UV/signature exposed household");
  if (!app.security.alert.textContent)
    throw Error("Rejected assertion has no feedback");
  return 2;
}

// A valid server-verified WebAuthn assertion is insufficient if the PRF output
// cannot unwrap this device's local vault. The encrypted event corpus must be
// byte-for-byte unchanged after that failed local unlock.
async function wrongPrfFailsClosed() {
  const app = document.querySelector("kin-app");
  const wrapper = app.security.manifest.wrappers.find((value) => value.type === "prf");
  if (!wrapper) throw new Error("wrong-PRF check requires the enrolled PRF wrapper");
  const originalSalt = wrapper.prfSalt;
  const before = await persistedEvents();
  let wrongSalt;
  do {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    wrongSalt = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  } while (wrongSalt === originalSalt);
  wrapper.prfSalt = wrongSalt;
  try {
    await app.security.run(() => app.security.unlockPasskey(wrapper));
    const after = await persistedEvents();
    if (app.vault !== null || app.state !== null || app.engine !== null)
      throw new Error("a valid assertion with incorrect PRF output exposed the local vault");
    if (!app.security.alert.textContent)
      throw new Error("a valid assertion with incorrect PRF output did not explain the failed unlock");
    if (after !== before)
      throw new Error("a failed wrong-PRF unlock changed encrypted local event bytes");
    return 3;
  } finally {
    wrapper.prfSalt = originalSalt;
  }

  async function persistedEvents() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open("kin");
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const database = request.result;
        const transaction = database.transaction("events");
        const rows = transaction.objectStore("events").getAll();
        transaction.oncomplete = () => { database.close(); resolve(JSON.stringify(rows.result)); };
        transaction.onabort = () => { database.close(); reject(transaction.error); };
      };
    });
  }
}

async function cancelPasskey() {
  const app = document.querySelector("kin-app");
  const wrapper = app.security.manifest.wrappers.find(
    (value) => value.type === "prf",
  );
  const originalGet = navigator.credentials.get.bind(navigator.credentials);
  navigator.credentials.get = (options) => {
    const controller = new AbortController();
    controller.abort();
    return originalGet({ ...options, signal: controller.signal });
  };
  try {
    await app.security.run(() => app.security.unlockPasskey(wrapper));
  } finally {
    delete navigator.credentials.get;
  }
  if (
    app.state !== null ||
    app.vault !== null ||
    !app.security.alert.textContent.includes("cancelled")
  )
    throw Error("Cancelled assertion escaped locked recovery state");
  return 1;
}

async function recoverPasskey(recovery) {
  const app = document.querySelector("kin-app");
  await app.security.run(() => app.security.unlockRecovery(recovery));
  if (app.state?.items[0]?.text !== "Virtual passkey protected content")
    throw Error("Independent recovery path was lost");
  app.ctx.session.lockHousehold();
  return 1;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const executable = process.argv[2];
  assert.ok(
    executable,
    "Usage: node scripts/passkey-regression.mjs <browser executable> ",
  );
  const profile = await mkdtemp(join(tmpdir(), "kin-passkey-"));
  const reservation = createServer();
  await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const applicationPort = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const origin = `http://localhost:${applicationPort}`;
  const { server, store, service, syncService } = createKinServer({
    port: applicationPort,
    host: "127.0.0.1",
    origin,
    store: new DurableStore(":memory:"),
  });
  await new Promise((resolve) =>
    server.listen(applicationPort, "127.0.0.1", resolve),
  );
  const browser = spawn(
    executable,
    [
      "--headless=new",
      "--disable-gpu",
      "--disable-extensions",
      "--no-first-run",
      "--no-default-browser-check",
      "--edge-skip-compat-layer-relaunch",
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
    socket.onmessage = ({ data }) => {
      const message = JSON.parse(data);
      if (message.method) loadTrace.observe(message);
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
    // Kin must have started before setupPasskey waits inside the page: a
    // start-up guard reload during that one call would end it (#469).
    await waitForKinStart(client.evaluate, origin, { navigate: () => send("Page.navigate", { url: origin }) });
    await passkeyRegressions(client, service, syncService);
  } catch (error) {
    // Before the browser closes: what each page showed (#328), and how the
    // tab loaded Kin (#594).
    printLoadTrace(loadTrace);
    await captureFailure("passkey regression");
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
    try {
      await new Promise((resolve) => server.close(resolve));
    } finally {
      store.close();
    }
    await delay(300);
    assert.ok(resolve(profile).startsWith(resolve(tmpdir()) + sep), "Refuse cleanup outside the test-profile directory");
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
  process.exit(0);
}
