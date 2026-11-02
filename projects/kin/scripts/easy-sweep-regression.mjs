// The easy-mode sweep (#639, story #638, ADR 0021): every main page and tab,
// in easy mode, at 320px and on a desktop, on the shared single-tab test
// household, with three household features switched off. On each page it
// checks:
// - Help is on the page (the heading's Help button, visible);
// - no control is under 56px (buttons, fields, menus, tabs and the
//   navigation);
// - no unexplained word: every glossary word in the page's visible text
//   (help/glossary.js jargonIn, outside the household's own records) is
//   explained under Help's "Words on this page";
// - switched-off features are absent: their routes open Today, and nothing
//   on the page or in the navigation shows or links to them.
// Every problem on every page is collected and reported together, so one run
// names everything to fix.
import assert from "node:assert/strict";
import { setViewport } from "./cdp-viewport.mjs";
import { ROUTES } from "./easy-mode-regression.mjs";

/** Features switched off during the sweep, and the routes they own. */
const OFF = Object.freeze({ fridge: ["household/fridge"], meals: ["lists/meals"], journal: ["journal"] });

// Runs in the page for one route: the measurements, or { redirected }.
async function measurePage({ key, offIds, offRoutes }) {
  const app = document.querySelector("kin-app");
  const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
  const { jargonIn } = await import("/help/glossary.js");
  app.ctx.navigation.navigate(`#${key}`);
  for (let i = 0; i < 4; i++) await frame();
  for (let i = 0; i < 200 && (app.busy || app.refreshing || app.pendingRefresh || app.wakePending); i++) await frame();
  if (app.route.canonical !== key) return { key, redirected: app.route.canonical };
  const section = app.pages.get(app.route.page);
  const shown = (node) => node.isConnected && !node.closest("[hidden]") && node.getClientRects().length > 0 &&
    node.getBoundingClientRect().width > 2;
  const describe = (node) => `${node.tagName.toLowerCase()}${node.className && typeof node.className === "string" ? `.${node.className.trim().split(/\s+/).join(".")}` : ""}` +
    `${node.textContent?.trim() ? `"${node.textContent.trim().slice(0, 30)}"` : ""}:${Math.round(node.getBoundingClientRect().height)}`;
  // Help on the page.
  const helpButton = section.querySelector(".page-intro .help-button");
  const help = Boolean(helpButton) && shown(helpButton);
  // Controls under 56px.
  const fields = "input:not([type=checkbox]):not([type=radio]):not([type=hidden]):not([type=range]):not([type=color]):not([type=file])";
  const controls = [...section.querySelectorAll(`button, select, textarea, summary, .segment-link, ${fields}`), ...app.navLinks.values()]
    .filter((node) => shown(node) && !node.closest(".visually-hidden, dialog:not([open])"));
  const small = controls.filter((node) => node.getBoundingClientRect().height < 55.5).map(describe);
  // Words: what the page shows (not the household's records) against Help.
  const records = "kin-item, [data-item-id], [data-record-id], .item-text, .note-body, .chat-row, .handoff-text, .chore-text, .chore-week-row, .cal-event, .cal-extra, .cal-month-events";
  const texts = [];
  const walker = document.createTreeWalker(section, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (!node.nodeValue.trim() || !parent || parent.closest(records) || !shown(parent)) continue;
    texts.push(node.nodeValue);
  }
  const onPage = jargonIn(texts.join("\n"));
  let explained = [];
  if (helpButton) {
    helpButton.click();
    await frame();
    const dialog = app.helpPanel.querySelector("dialog");
    explained = [...dialog.querySelectorAll(".help-words dt")].map((term) => term.textContent.toLowerCase());
    dialog.querySelector(".help-close").click();
    await frame();
  }
  const unexplained = onPage.filter((term) => !explained.includes(term));
  // Switched-off features: nothing shows or links to them.
  const featureParts = [...section.querySelectorAll("[data-feature]"), ...app.navLinks.values()]
    .filter((node) => shown(node) && (node.dataset.feature ?? "").split(/\s+/).some((id) => offIds.includes(id)))
    .map(describe);
  const links = [...section.querySelectorAll("a[href^='#']"), ...app.navLinks.values()]
    .filter((node) => shown(node) && offRoutes.some((route) => node.getAttribute("href") === `#${route}` || node.getAttribute("href")?.startsWith(`#${route}/`)))
    .map(describe);
  const navigation = [...app.navLinks.entries()].filter(([, link]) => shown(link)).map(([id]) => id);
  const segments = [...(app.segmentNavs.get(app.route.page)?.querySelectorAll(".segment-link") ?? [])]
    .filter(shown).map((link) => `${app.route.page}/${link.dataset.segment}`);
  return {
    key, help, small, unexplained, explained, onPage,
    offShown: [...featureParts, ...links, ...navigation.filter((id) => offRoutes.includes(id)), ...segments.filter((route) => offRoutes.includes(route))],
    sideways: document.documentElement.scrollWidth - innerWidth,
  };
}

export async function easySweepRegressions(client, { until }) {
  const page = (expression) => client.evaluate(expression);
  const offIds = Object.keys(OFF);
  const offRoutes = Object.values(OFF).flat();
  // Easy mode on, and the three features off as on any member's device
  // (the service's set, ctx.features.receive).
  const before = await page(`(async () => {
    const app = document.querySelector("kin-app");
    const { FEATURES } = await import("/features.js");
    const off = FEATURES.filter((entry) => ${JSON.stringify(offIds)}.includes(entry.id)).reduce((mask, entry) => mask | (2 ** entry.bit), 0);
    const before = { off: app.ctx.features.off, revision: app.ctx.features.revision, admin: app.ctx.features.admin, easy: app.ctx.easy.chosen };
    localStorage.removeItem("kin.easy-recent");
    await app.ctx.easy.set(true);
    app.ctx.features.receive({ off, revision: app.ctx.features.revision + 1, admin: false });
    return before;
  })()`);
  await until(() => page(`document.documentElement.dataset.kinEasy === "on"`), { attempts: 100 });
  const problems = [];
  let pages = 0;
  for (const [label, metrics] of [
    ["320px", { width: 320, height: 640, deviceScaleFactor: 2, mobile: true }],
    ["desktop", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false }],
  ]) {
    await setViewport(client, metrics);
    for (const key of ROUTES) {
      const result = await page(`(${measurePage.toString()})(${JSON.stringify({ key, offIds, offRoutes })})`);
      const isOff = offRoutes.includes(key);
      if (isOff) {
        if (result.redirected !== "today") problems.push(`${label} ${key}: a switched-off feature's route should open Today, opened ${result.redirected ?? key}`);
        continue;
      }
      if (result.redirected) { problems.push(`${label} ${key}: opened ${result.redirected} instead`); continue; }
      pages += 1;
      if (!result.help) problems.push(`${label} ${key}: no Help button on the page`);
      if (result.small.length) problems.push(`${label} ${key}: controls under 56px: ${result.small.join(", ")}`);
      if (result.unexplained.length) problems.push(`${label} ${key}: words Help doesn't explain: ${result.unexplained.join(", ")} (Help explains ${result.explained.join(", ") || "none"})`);
      if (result.offShown.length) problems.push(`${label} ${key}: switched-off features still show: ${result.offShown.join(", ")}`);
      if (result.sideways > 0) problems.push(`${label} ${key}: scrolls sideways by ${result.sideways}px`);
    }
  }
  // Back as it was.
  await page(`(async () => {
    const app = document.querySelector("kin-app");
    const before = ${JSON.stringify(before)};
    app.ctx.features.receive({ off: before.off, revision: app.ctx.features.revision + 1, admin: before.admin });
    await app.ctx.easy.set(before.easy);
    localStorage.removeItem("kin.easy-recent");
    app.ctx.navigation.navigate("#today");
    return true;
  })()`);
  await client.send("Emulation.clearDeviceMetricsOverride");
  assert.deepEqual(problems, [], `easy-mode sweep found ${problems.length} problem(s):\n${problems.join("\n")}`);
  return `PASS easy-mode sweep: ${pages} page views at 320px and desktop with Help, every control at least 56px, every harder word explained, and switched-off Fridge, Meals and Journal absent (#639)`;
}
