// Home-screen shortcuts and the count on the app icon (#471) in the real app.
//
// Shortcuts (#472, #475): every shortcut in the manifest is opened twice:
// as a fresh load while Kin is locked (unlock, then land) and into a running,
// unlocked Kin (the address changes in place). Each must land on its page,
// with Quick add open on the right list and focus in its title field for the
// "Add" shortcuts, and the address cleared of the action. Simple view and a
// Temporary member land somewhere they can use.
//
// The icon count (#476, #479): with a stubbed navigator.setAppBadge, the
// setting under Notifications is Off by default, "Unread messages" puts the
// chat's unread count on the icon, reading clears it, and locking clears it.
// The setting hides where the browser has no Badging API.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// Where each manifest shortcut must land. A new shortcut needs a line here.
const LANDINGS = Object.freeze({
  "/#kin-action=add-shopping": { hash: "#lists/shopping", page: "lists", destination: "Adds to Shopping." },
  "/#kin-action=quick-add": { hash: "#lists/todo", page: "lists", destination: "Adds to To do." },
  // New journal entry (#509): the Journal page, whose editor opens once
  // private storage is open on the device (journal-regression.mjs drives
  // that with a password account; this suite's household has none).
  "/#kin-action=new-journal-entry": { hash: "#journal", page: "journal" },
  "/#week": { hash: "#week", page: "week" },
  "/#lists/shopping": { hash: "#lists/shopping", page: "lists" },
  "/#updates/chat": { hash: "#updates/chat", page: "updates" },
  "/#today": { hash: "#today", page: "today" },
});

export async function shortcutsBadgeRegressions(client, { origin, until, ready, recovery }) {
  const page = (expression) => client.evaluate(expression);
  // During a navigation the page's context can vanish mid-call.
  const safely = (expression) => async () => { try { return await page(expression); } catch { return false; } };
  const manifest = JSON.parse(await readFile(new URL("../web/manifest.webmanifest", import.meta.url), "utf8"));
  const urls = manifest.shortcuts.map((shortcut) => shortcut.url);
  assert.deepEqual(urls.filter((url) => !LANDINGS[url]), [], "every manifest shortcut has an expected landing");
  for (const name of ["Add to shopping", "Add a task", "This week"])
    assert.ok(manifest.shortcuts.some((shortcut) => shortcut.name === name), `the manifest offers ${name}`);

  // What the app shows now, for one expected landing.
  const landed = (expected) => page(`(() => {
    const app = document.querySelector("kin-app");
    const expected = ${JSON.stringify(expected)};
    const dialog = app.quickAdd.querySelector("dialog");
    const pageShown = app.pages?.get(expected.page);
    // Without chat access Chat's links go to Handoffs (#123).
    const hash = expected.page === "updates" && app.chatAccess === "none" ? "#updates/handoffs" : expected.hash;
    return {
      hash: location.hash === hash,
      shown: Boolean(pageShown && !pageShown.hidden),
      dialog: dialog.open === Boolean(expected.destination),
      destination: !expected.destination || app.quickAdd.destination.textContent === expected.destination,
      // Quick add: focus in its title. A page: focus at the start of the page
      // (the main region, where the unlock put it) and never in a hidden view.
      focus: expected.destination ? document.activeElement === app.quickAdd.input
        : (document.activeElement === app.main || (app.main.contains(document.activeElement) && !document.activeElement.closest("[hidden]"))),
    };
  })()`);
  const everyTrue = (facts) => Object.values(facts).every(Boolean);
  const closeQuickAdd = () => page(`(() => {
    const app = document.querySelector("kin-app");
    const dialog = app.quickAdd.querySelector("dialog");
    if (dialog.open) { app.quickAdd.reset(); }
    return true;
  })()`);

  // 1. Each shortcut opened as a fresh load while locked: unlock, then land.
  for (const url of urls) {
    const expected = LANDINGS[url];
    // A shortcut starts Kin afresh. Only the fragment differs from where the
    // tab is, so give the current page another address first: the shortcut
    // is then a real load, not an in-page jump. The old page is marked so
    // its own lock on the way out isn't mistaken for the new page's.
    await page('(() => { window.__beforeShortcut = true; history.replaceState(null, "", "/?before-shortcut=1"); return true; })()');
    await client.send("Page.navigate", { url: `${origin}${url}` });
    await until(safely('(() => { const app = document.querySelector("kin-app"); return !window.__beforeShortcut && Boolean(app?.security?.heading) && app.security.phase !== "unlocked" && !app.starting; })()'), { attempts: 600 });
    const before = await page("location.hash");
    if (url.includes("kin-action=")) assert.equal(before, "", `${url}: the action is taken out of the address at once, while locked`);
    else assert.equal(before, url.slice(1), `${url}: a page shortcut waits in the address while locked`);
    await page(`document.querySelector("kin-app").security.unlockRecovery(${JSON.stringify(recovery)})`);
    try {
      await until(async () => everyTrue(await landed(expected)), { attempts: 600 });
    } catch (error) {
      throw new Error(`${url} opened while locked didn't land after unlock: ${JSON.stringify(await landed(expected))}`, { cause: error });
    }
    await closeQuickAdd();
  }
  console.log(`PASS each shortcut opened while locked lands after unlock, with focus (${urls.length} shortcuts, #472)`);

  // 2. Each shortcut opened into a running, unlocked Kin.
  for (const url of urls) {
    const expected = LANDINGS[url];
    await page(`(() => { const app = document.querySelector("kin-app"); app.ctx.navigation.navigate("#household"); app.main.focus(); return true; })()`);
    await page(`location.hash = ${JSON.stringify(url.slice(1))}`);
    // Into a running Kin a page shortcut is an ordinary route change, which
    // leaves focus where it was, as every in-app navigation does; only the
    // Add shortcuts move focus (into Quick add).
    const facts = async () => {
      const result = await landed(expected);
      if (!expected.destination) delete result.focus;
      return result;
    };
    try {
      await until(async () => everyTrue(await facts()));
    } catch (error) {
      throw new Error(`${url} opened while unlocked didn't land: ${JSON.stringify(await facts())}`, { cause: error });
    }
    await closeQuickAdd();
  }
  // A stale or unknown action does nothing but leave the address clean.
  const stale = await page(`(async () => {
    const app = document.querySelector("kin-app");
    app.ctx.navigation.navigate("#today");
    location.hash = "#kin-action=delete-everything";
    for (let i = 0; i < 60 && location.hash !== "#today" && location.hash !== ""; i++) await new Promise((resolve) => requestAnimationFrame(resolve));
    return { hash: location.hash, open: app.quickAdd.querySelector("dialog").open, page: app.route.page };
  })()`);
  assert.ok(["", "#today"].includes(stale.hash) && !stale.open && stale.page === "today", `an unknown shortcut is ignored and cleared (${JSON.stringify(stale)})`);
  console.log("PASS each shortcut opened into a running Kin lands at once; an unknown one is ignored (#472)");

  // 3. A Temporary member stays where the shortcut took them, not For you.
  const temporary = await page(`(() => {
    const app = document.querySelector("kin-app");
    const status = app.householdStatus, landedBefore = app.sitterLanded;
    app.householdStatus = { ...(status ?? {}), memberKind: "temporary" };
    app.sitterLanded = false;
    try {
      app.ctx.share.land("add-shopping");
      app.ctx.sitter.landTemporaryMember();
      return { route: app.route.canonical, focus: document.activeElement === app.quickAdd.input };
    } finally {
      app.quickAdd.reset();
      app.householdStatus = status;
      app.sitterLanded = landedBefore;
    }
  })()`);
  assert.deepEqual(temporary, { route: "lists/shopping", focus: true }, "a Temporary member's shortcut isn't overridden by the For you landing");

  // 4. The count on the app icon, with a stubbed Badging API.
  const badge = await page(`(async () => {
    const app = document.querySelector("kin-app");
    const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
    const calls = [];
    window.__badgeCalls = calls;
    Object.defineProperty(navigator, "setAppBadge", { configurable: true, value: (count) => { calls.push(count); return Promise.resolve(); } });
    Object.defineProperty(navigator, "clearAppBadge", { configurable: true, value: () => { calls.push(0); return Promise.resolve(); } });
    localStorage.removeItem("kin.app-badge");
    app.ctx.badge.choice = "off";
    app.ctx.navigation.navigate("#household/people");
    // The setting was built for this unlock; connect it again as a page would.
    const setting = app.appBadge;
    setting.remove();
    app.notifications.after(setting);
    await frame();
    const radios = [...setting.querySelectorAll('input[type="radio"]')];
    const result = {
      visible: !setting.hidden && setting.getClientRects().length > 0,
      underNotifications: setting.previousElementSibling === app.notifications,
      labels: radios.map((radio) => radio.closest("label").textContent),
      offByDefault: radios.find((radio) => radio.checked)?.value,
      heading: setting.querySelector("h2")?.textContent,
    };
    const unread = (count) => app.chat.dispatchEvent(new CustomEvent("kin:chat-unread", { bubbles: true, composed: true, detail: { count, mentions: 0, capped: false } }));
    calls.length = 0;
    unread(2);
    result.offIgnoresUnread = calls.filter((count) => count > 0).length === 0;
    radios.find((radio) => radio.value === "messages").click();
    result.saved = localStorage.getItem("kin.app-badge");
    result.feedback = setting.querySelector('[role="status"]').textContent;
    result.afterChoosing = calls.at(-1);
    unread(3);
    result.newMessage = calls.at(-1);
    unread(0);
    result.afterReading = calls.at(-1);
    unread(4);
    result.again = calls.at(-1);
    return result;
  })()`);
  assert.deepEqual(badge, {
    visible: true,
    underNotifications: true,
    labels: ["Off", "Unread messages", "Unread messages and my things today"],
    offByDefault: "off",
    heading: "Count on the app icon",
    offIgnoresUnread: true,
    saved: "messages",
    feedback: "The app icon shows: unread messages.",
    afterChoosing: 2,
    newMessage: 3,
    afterReading: 0,
    again: 4,
  }, "the icon count: Off by default, then the unread count, cleared by reading");

  // Locking clears it; unlocking brings it back from what's unread then.
  await page(`(() => { document.querySelector("kin-app").ctx.session.lockHousehold(false); return true; })()`);
  assert.equal(await page("window.__badgeCalls.at(-1)"), 0, "locking clears the icon count");
  await page(`document.querySelector("kin-app").security.unlockRecovery(${JSON.stringify(recovery)})`);
  await until(safely('Boolean(document.querySelector("kin-app")?.store && !document.querySelector("kin-app").busy)'), { attempts: 600 });

  // Unsupported: the setting hides; turning the count off clears the icon.
  const unsupported = await page(`(async () => {
    const app = document.querySelector("kin-app");
    app.chat.dispatchEvent(new CustomEvent("kin:chat-unread", { bubbles: true, composed: true, detail: { count: 5, mentions: 0, capped: false } }));
    const shownAgain = window.__badgeCalls.at(-1) === 5;
    app.ctx.badge.setChoice("off");
    const cleared = shownAgain && window.__badgeCalls.at(-1) === 0;
    Object.defineProperty(navigator, "setAppBadge", { configurable: true, value: undefined });
    const setting = document.createElement("kin-app-badge");
    document.body.append(setting);
    const hidden = setting.hidden;
    setting.remove();
    delete navigator.setAppBadge;
    delete navigator.clearAppBadge;
    delete window.__badgeCalls;
    return { cleared, hidden, stored: localStorage.getItem("kin.app-badge") };
  })()`);
  assert.deepEqual(unsupported, { cleared: true, hidden: true, stored: null }, "Off clears the icon and forgets the choice; no Badging API, no setting");
  console.log("PASS the app icon count: Off by default, unread messages, cleared by reading and by locking; hidden without the API (#476)");

  // 5. Simple view has no Quick add: an "Add" shortcut lands on Today.
  const simple = await page(`(async () => {
    const app = document.querySelector("kin-app");
    app.ctx.simple.enter();
    app.ctx.share.land("add-shopping");
    const today = app.pages.get("today");
    return { route: app.route.canonical, focus: document.activeElement === today.querySelector("h1"),
      dialog: app.quickAdd.querySelector("dialog").open, status: app.status.textContent };
  })()`);
  assert.deepEqual(simple, { route: "today", focus: true, dialog: false, status: "Adding things isn't available in Simple view, so Kin opened Today." },
    "in Simple view an Add shortcut lands on Today, focused, and says why");
  // Back to the full layout, as the Simple view drill does.
  await client.send("Page.reload");
  await ready(client);
  await page('location.hash = "#today"');
  return "PASS Simple view and Temporary members land somewhere they can use (#472)";
}
