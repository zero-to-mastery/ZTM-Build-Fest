import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Runs inside the browser against the real components, storage and WASM replay.
// Covers the v0.41.0 capture defaults, list quick-add, item Details disclosure,
// household get-started choices, human-readable state messages, security
// settings, and the passkey-first lock screen presentation.
export async function mobileUxRegressions(recovery) {
  const app = document.querySelector("kin-app");
  const check = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const idle = async () => {
    for (let index = 0; (app.busy || app.refreshing || app.pendingRefresh || app.wakePending) && index < 300; index++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    check(!app.busy && !app.refreshing && !app.pendingRefresh && !app.wakePending, "mobile UX work returns idle");
  };
  const wait = async (condition, label) => {
    for (let index = 0; index < 400; index++) {
      if (condition()) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`mobile UX wait timed out: ${label}`);
  };
  const visit = (id) => { location.hash = `#${id}`; app.ctx.navigation.showPageFromLocation(); };
  const visible = (node) => Boolean(node) && !node.closest("[hidden]") && node.getClientRects().length > 0;

  // 1. The Today capture asks what the item is and when it matters; it never
  //    creates a `today`-classified record, and the chosen kind sticks.
  const probe = document.createElement("kin-compose");
  probe.setAttribute("mode", "today");
  document.body.append(probe);
  check(probe.classification.value === "need" && probe.plan.value === "today" && !probe.pin.checked &&
    [...probe.classification.options].map((option) => option.value).join(",") === "need,shopping",
    "fresh Today capture defaults to a task planned for today, offering Task or Shopping item");
  probe.remove();
  visit("today");
  app.compose.classification.value = "need";
  app.compose.plan.value = "today";
  app.compose.input.value = "Call the dentist";
  app.compose.form.requestSubmit();
  await idle();
  const todayItem = app.state.items.find((item) => item.text === "Call the dentist");
  check(todayItem?.classification === "need" && todayItem.planningDate === app.ctx.navigation.currentCivilDate() &&
    visible(app.today.querySelector(`.item-text[data-item-id="${todayItem.itemId}"]`)) &&
    app.needs.querySelector(`.item-text[data-item-id="${todayItem.itemId}"]`),
    "adding from Today creates a task planned for today that shows on Today and lives in To do");
  check(app.status.textContent === "Added to To do and Today." && app.compose.input.value === "" && app.compose.classification.value === "need" &&
    app.compose.result.textContent === "Saved on this device.",
    `Today add confirms its destination inline and keeps the kind selected: ${app.status.textContent} / ${app.compose.result.textContent}`);
  app.compose.classification.value = "shopping";
  app.compose.plan.value = "none";
  app.compose.input.value = "Eggs from Today";
  app.compose.form.requestSubmit();
  await idle();
  check(app.state.items.find((item) => item.text === "Eggs from Today")?.classification === "shopping" &&
    app.state.items.find((item) => item.text === "Eggs from Today").planningDate === null &&
    app.status.textContent === "Added to Shopping." && app.compose.classification.value === "shopping" && app.compose.plan.value === "none",
    "a chosen kind and plan are confirmed and not silently reset");
  app.compose.classification.value = "need";
  app.compose.plan.value = "today";

  // 2. Each list carries its own capture with a fixed destination and clear hints.
  visit("lists/shopping");
  check(!app.today.querySelector("kin-compose"), "the Today list itself embeds no second capture form");
  for (const [list, classification, title] of [[app.needs, "need", "To do"], [app.shopping, "shopping", "Shopping"], [app.staples, "staple", "Staples"]]) {
    const composer = list.querySelector("kin-compose");
    check(composer?.fixedClassification === classification && composer.classification.hidden && composer.classificationField.hidden,
      `${title} quick-add fixes its destination without a dropdown`);
    check(composer.input.getAttribute("aria-label") === `Add to ${title}` && composer.input.placeholder === `Add to ${title}`,
      `${title} quick-add is labelled with its destination`);
    check(list.querySelector(".section-hint")?.textContent.length > 0, `${title} explains what belongs in it`);
  }
  const shoppingComposer = app.shopping.querySelector("kin-compose");
  shoppingComposer.input.value = "Eggs";
  shoppingComposer.input.focus();
  shoppingComposer.form.requestSubmit();
  await idle();
  const eggs = app.state.items.find((item) => item.text === "Eggs");
  check(eggs?.classification === "shopping" && visible(app.shopping.querySelector(`.item-text[data-item-id="${eggs.itemId}"]`)) &&
    !app.needs.querySelector(`.item-text[data-item-id="${eggs.itemId}"]`),
    "adding eggs from Shopping creates a Shopping item, not a Need");
  check(app.status.textContent === "Added to Shopping." && shoppingComposer.input.value === "" && document.activeElement === shoppingComposer.input,
    "Shopping quick-add confirms, clears and keeps focus for the next item");
  const needsComposer = app.needs.querySelector("kin-compose");
  needsComposer.input.value = "Fix the gate latch";
  needsComposer.form.requestSubmit();
  await idle();
  check(app.state.items.find((item) => item.text === "Fix the gate latch")?.classification === "need" && app.status.textContent === "Added to To do.",
    "To do quick-add creates a task");

  // 3. Item rows show a complete control, the text, Add photo and Details;
  //    everything else lives in the shared detail view.
  const eggsRow = [...app.shopping.querySelectorAll("kin-item")].find((node) => node.record?.itemId === eggs.itemId);
  const toggle = () => app.shopping.querySelector(`.item-details-button[data-item-id="${eggs.itemId}"]`);
  check(visible(eggsRow.querySelector(".complete-button")) && toggle()?.getAttribute("aria-expanded") === "false" && app.selection === null,
    "a list row shows a complete control and a closed Details control");
  check(!eggsRow.querySelector(".item-area-select") && !eggsRow.querySelector(".item-planning-date-input") &&
    !eggsRow.querySelector(".pin-button") && !eggsRow.querySelector('input[type="file"]') && !eggsRow.querySelector(".step-summary"),
    "area, planned date, pin and step-count controls are absent from a plain row and the row owns no file input");
  const attachButton = eggsRow.querySelector(".item-attach-button");
  check(visible(attachButton) && attachButton.textContent === "Add photo" && attachButton.getAttribute("aria-label") === "Add a photo or file to Eggs" &&
    attachButton.getBoundingClientRect().height >= 44,
    "Add photo is visible on the collapsed row as a labelled 44px button");
  check(app.attachmentInput?.type === "file" && app.attachmentInput.accept === "image/jpeg,image/png,image/webp,application/pdf" &&
    app.querySelectorAll('input[type="file"]').length === 1,
    "one app-owned file input accepts photos and PDFs");
  toggle().focus();
  toggle().click();
  check(toggle()?.getAttribute("aria-expanded") === "true" && app.selection?.itemId === eggs.itemId && app.detail.isConnected && app.detail.itemId === eggs.itemId,
    "Details opens the shared detail view for that item");
  check(document.activeElement === app.detail.querySelector(".item-detail-title"), "opening details moves focus to the detail heading");
  check(visible(app.detail.querySelector(".item-area-select")) && visible(app.detail.querySelector(".item-planning-date-input")) &&
    visible(app.detail.querySelector(".pin-button")) && visible(app.detail.querySelector(".archive-button")) &&
    app.detail.querySelectorAll(".attachment-add").length === 1 && app.querySelectorAll('input[type="file"]').length === 1,
    "the detail view holds area, planned date, pin, archive and one Add a photo or file button; the app still owns a single file input");
  app.detail.querySelector(".complete-button").click();
  await idle();
  const completedRow = [...app.shopping.querySelectorAll("kin-item")].find((node) => node.record?.itemId === eggs.itemId);
  check(completedRow.querySelector(".item-completed") && completedRow.querySelector(".reopen-button")?.getAttribute("aria-pressed") === "true", "completion is visibly marked on the row");
  check(app.selection?.itemId === eggs.itemId && app.detail.querySelector(".reopen-button") && /^Marked “.+” done\./.test(app.status.textContent),
    "completion keeps details open for the same record, offers Reopen and confirms");
  app.detail.querySelector(".reopen-button").click();
  await idle();
  app.detail.querySelector(".item-detail-close").click();
  check(app.selection === null && !app.detail.isConnected && document.activeElement === toggle(),
    "closing details restores focus to the row's Details control");

  // 4. Without a household, Today offers the three ways to get started.
  await wait(() => app.householdStatus !== null, "household status event");
  const populatedState = app.state;
  app.state = {};
  app.ctx.status.renderOnboarding();
  check(app.onboarding.querySelector(".onboarding-details")?.open === true,
    "Get started stays expanded before any household activity");
  app.state = populatedState;
  app.ctx.status.renderOnboarding();
  check(app.householdStatus.identity === false && app.onboarding.hidden === false &&
    app.onboarding.querySelector("h2")?.textContent === "Get started",
    "a device without a household sees Get started on Today");
  const onboardingDetails = app.onboarding.querySelector(".onboarding-details");
  check(onboardingDetails?.open === false && onboardingDetails.querySelector("summary")?.textContent === "Join or set up your household",
    "Get started collapses after local household activity so Today stays visible");
  const onboardingLabels = [...app.onboarding.querySelectorAll("button")].map((button) => button.textContent);
  check(JSON.stringify(onboardingLabels) === JSON.stringify(["Start a new household", "Join my household", "Add my device", "Sign in using my phone"]),
    `Get started offers create, join, sign in with a phone (#100) and add-device: ${onboardingLabels.join("|")}`);
  visit("today");
  check(visible(onboardingDetails.querySelector("summary")), "the compact Get started summary stays visible on Today");
  window.scrollTo(0, 0);
  const firstTodayRow = [...app.today.querySelectorAll("kin-item .item-row")].find(visible);
  check(firstTodayRow?.getBoundingClientRect().top < app.onboarding.getBoundingClientRect().top,
    "the compact Get started prompt follows the first Today task instead of hiding it");
  onboardingDetails.querySelector("summary").click();
  check(onboardingDetails.open, "the compact Get started guidance expands with its native disclosure");
  app.ctx.status.updateOnboardingDensity();
  check(onboardingDetails.open, "a refresh does not close Get started after the user expands it");
  onboardingLabels.length && [...app.onboarding.querySelectorAll("button")][1].click();
  await wait(() => location.hash === "#household/people" && app.household.intent === "join", "join intent");
  check(Boolean(app.household.querySelector('input[name="code"]')) &&
    app.household.textContent.includes("never creates a second household") &&
    [...app.household.querySelectorAll("button")].some((button) => button.textContent === "Back"),
    "Join shows the code form and states that a code never creates a second household");
  app.household.startIntent("device");
  check(app.household.textContent.includes("People & devices → Add my device") && Boolean(app.household.querySelector('input[name="code"]')),
    "Add my device explains the existing-device step and uses the same approval flow");
  app.household.startIntent("create");
  check([...app.household.querySelectorAll("button")].some((button) => button.textContent === "Create household with passkey") &&
    app.household.textContent.includes("join theirs instead"),
    "Create explains that it starts a new household and warns joiners");
  check(!app.household.querySelector('input[name="deviceLabel"]') &&
    // The name follows this machine's platform (Windows on the Edge job,
    // Linux on the Chrome job; #329).
    (app.household.querySelector("p.device-name")?.textContent ?? "").includes(` on ${/Windows/.test(navigator.userAgent) ? "Windows" : /Mac OS X/.test(navigator.userAgent) ? "Mac" : "Linux"}”`) &&
    app.household.querySelector("p.device-name").textContent.includes("nickname later"),
    "Create names the device automatically and asks nobody to type a name (#71)");
  app.household.startIntent(null);
  const chooser = [...app.household.querySelectorAll("button")].map((button) => button.textContent);
  check(chooser.includes("Start a new household") && chooser.includes("Join my household") &&
    chooser.includes("Add my device") && chooser.includes("Sign in using my phone") &&
    chooser.includes("Sign in with my passkey"),
    `the household chooser offers every path: ${chooser.join("|")}`);
  check(app.household.textContent.includes("a member must approve you before anything is shared"),
    "device protection and household membership are distinguished in plain language");

  // 5. Sync pauses, offline and attachment failures speak plainly and keep codes.
  app.ctx.sync.handleSyncState({ state: "paused", code: "device_not_trusted", message: "device_not_trusted" });
  check(!app.stateNotice.hidden && app.stateNotice.textContent === "This device no longer has access to household updates. Everything already saved here stays on this device.",
    "revoked device access is explained without jargon");
  app.ctx.sync.handleSyncState({ state: "paused", code: "connection_unavailable", message: "fetch failed" });
  check(app.stateNotice.textContent === "Your changes are saved on this device and will sync when you're connected.",
    "connection loss promises nothing beyond local saving");
  app.ctx.sync.handleSyncState({ state: "paused", code: "strange_code", message: "A custom server message." });
  check(app.stateNotice.textContent === "A custom server message.", "unknown pause codes keep the server message");
  app.ctx.sync.handleSyncState({ state: "ready" });
  check(app.stateNotice.hidden, "a ready sync clears the notice");
  window.dispatchEvent(new Event("offline"));
  check(!app.stateNotice.hidden && app.stateNotice.textContent === "You're offline. Your changes are saved on this device." && !app.stateNotice.textContent.includes("sync"),
    `offline without a household does not promise sync: ${app.stateNotice.textContent}`);
  window.dispatchEvent(new Event("online"));
  check(app.stateNotice.hidden, "coming back online clears the offline notice");
  app.ctx.status.clearAlert();
  await app.ctx.attachments.handleViewAttachment({ detail: { attachmentId: "00".repeat(16), parentKind: "item", parentId: eggs.itemId } });
  check(app.alert.textContent === "We couldn't open this attachment. Your existing household information hasn't been deleted.",
    "a missing attachment is explained without implying deletion");
  app.ctx.status.clearAlert();

  // 6. Security settings show passkey state and an inactivity lock preference.
  visit("household/privacy");
  const passkeyStatus = app.security.querySelector("[data-passkey-unlock]");
  check(passkeyStatus?.dataset.passkeyUnlock === "off" && passkeyStatus.textContent.startsWith("Off"),
    "settings show that passkey unlock is off on this device");
  check([...app.security.querySelectorAll("button")].some((button) => button.textContent === "Turn on passkey unlock"),
    "settings offer to turn on passkey unlock");
  check(app.security.querySelector("details.security-guidance summary")?.textContent === "Backup key guidance" &&
    [...app.security.querySelectorAll("button")].some((button) => button.textContent === "Replace backup key"),
    "backup key guidance and replacement remain available");
  const autoLock = app.security.querySelector("#auto-lock-minutes");
  check(autoLock?.value === "0" && app.autoLockTimer === null, "automatic lock defaults to lock-on-close only");
  autoLock.value = "5";
  autoLock.dispatchEvent(new Event("change", { bubbles: true }));
  check(app.autoLockMinutes === 5 && localStorage.getItem("kin.auto-lock-minutes") === "5" && app.autoLockTimer !== null,
    "an inactivity lock preference is stored as a plain number and starts a timer");
  const previousActivity = app.lastActivityAt;
  document.dispatchEvent(new Event("pointerdown"));
  check(app.lastActivityAt >= previousActivity, "actual user activity resets the inactivity deadline");
  // The clock is stubbed rather than slept on (#469): on Windows, Date.now()
  // need not advance across a short timer, so a later scroll could store the
  // same time as the pointerdown.
  const pointerActivity = app.lastActivityAt;
  const wallNow = Date.now;
  try {
    Date.now = () => pointerActivity + 60_000;
    document.dispatchEvent(new Event("scroll", { bubbles: true }));
    check(app.lastActivityAt === pointerActivity + 60_000 && app.autoLockTimer !== null,
      `scroll activity resets the inactivity deadline: ${app.lastActivityAt} vs ${pointerActivity}, timer ${app.autoLockTimer !== null}, locked ${app.vault?.locked}`);
  } finally {
    Date.now = wallNow;
  }
  autoLock.value = "0";
  autoLock.dispatchEvent(new Event("change", { bubbles: true }));
  check(app.autoLockMinutes === 0 && app.autoLockTimer === null, "turning the inactivity lock off clears the timer");
  app.ctx.session.setAutoLockMinutes(5);
  const storageDump = [...Object.keys(localStorage), ...Object.keys(sessionStorage)]
    .map((key) => `${key}=${localStorage.getItem(key) ?? sessionStorage.getItem(key)}`).join("\n");
  check(!/[a-f0-9]{64}/i.test(storageDump) && !storageDump.includes(recovery), "no recovery or key material reaches web storage");

  // 7. Time spent suspended counts toward the configured inactivity limit.
  const visibilityDescriptor = Object.getOwnPropertyDescriptor(document, "visibilityState");
  const realNow = Date.now;
  try {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
    Date.now = () => realNow() + 6 * 60_000;
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
  } finally {
    Date.now = realNow;
    if (visibilityDescriptor) Object.defineProperty(document, "visibilityState", visibilityDescriptor);
    else delete document.visibilityState;
  }
  check(app.vault === null && app.state === null && app.autoLockTimer === null,
    "resuming after the configured inactivity limit locks before continuing");
  await app.lockBarrier;

  // 8. Locking returns to a recovery-first screen while no passkey is enrolled.
  check(app.vault === null && app.security.heading.textContent === "Welcome back" &&
    app.security.querySelector(".recovery-form")?.hidden === false &&
    ![...app.security.querySelectorAll("button")].some((button) => button.textContent.startsWith("Unlock with passkey")),
    "the lock screen offers recovery directly when no passkey is enrolled");
  check(app.onboarding.hidden && app.onboarding.childElementCount === 0, "locking clears the onboarding card");
  await app.security.run(() => app.security.unlockRecovery(recovery));
  await wait(() => app.store && !app.busy && !app.security.busy, "re-unlock");
  await wait(() => app.householdStatus !== null, "household status after unlock");
  visit("today");
  check(app.vault && !app.vault.locked && app.state !== null, "recovery unlock restores the household state after background lock");
  check(app.onboarding.hidden === false, "Get started returns after unlocking a device without a household");
  app.ctx.session.setAutoLockMinutes(0);
  return "PASS Today/Lists capture defaults, list quick-add, item Details disclosure, get-started choices, plain-language state messages, security settings and lock screen";
}

// The regression body runs inside the shared real-browser fixture. When run
// directly, delegate to that fixture so this command cannot silently do nothing.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const executable = process.argv[2];
  if (!executable) {
    console.error("Usage: node scripts/mobile-ux-regression.mjs <browser executable>");
    process.exitCode = 2;
  } else {
    const runner = join(dirname(fileURLToPath(import.meta.url)), "browser-regression.mjs");
    const result = spawnSync(process.execPath, [runner, executable], { stdio: "inherit", windowsHide: true });
    process.exitCode = result.status ?? 1;
  }
}
