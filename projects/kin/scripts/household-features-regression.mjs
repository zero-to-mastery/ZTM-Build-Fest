// Household features (#623–#626, ADR 0021 §2) in the real app, through the
// real store and engine. Runs in the page (serialized with toString).
//
// This test household doesn't sync, so its one person decides and the
// choice is kept on the device: the admin turns off Meals, Fridge, Routines
// and Notes & reference on Household › Features. Then the page takes the set
// the way every other member's device does, from the service's status
// (`ctx.features.receive`, as the sync coordinator calls it) with `admin`
// false: navigation, Today, This week's link, Search and Quick add lose
// them, the Fridge's and the others' routes open Today with a calm line, the
// one-time note shows, and the Features page is read-only. The service's own
// refusal of the Fridge and Chat routes is covered by
// server/household-features.test.mjs. Back as the admin, everything is
// switched on again and what was there before (tonight's dinner, a note)
// comes back.
export async function householdFeaturesRegressions() {
  const app = document.querySelector("kin-app");
  const check = (condition, message, detail) => {
    if (!condition) throw new Error(`${message}${detail === undefined ? "" : ` ${JSON.stringify(detail)}`}`);
  };
  const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
  const until = async (test, message, detail) => {
    for (let index = 0; index < 900; index++) { if (test()) return; await frame(); }
    check(false, `Timed out: ${message}`, typeof detail === "function" ? detail() : detail);
  };
  const idle = () => until(() => !app.busy && !app.refreshing && !app.pendingRefresh && !app.wakePending && !app.ctx.meals.loading, "the work settles");
  const visible = (node) => Boolean(node) && node.isConnected && node.getClientRects().length > 0;
  const segments = (page) => [...(app.segmentNavs.get(page)?.querySelectorAll(".segment-link") ?? [])].map((link) => link.dataset.segment);
  const features = app.ctx.features;
  const tag = crypto.randomUUID().slice(0, 6);
  const OFF = ["meals", "fridge", "routines", "notes"];

  // Something in Meals and in Notes & reference first.
  const today = app.ctx.meals.today();
  const previousDinner = app.mealsState?.dinners.find((entry) => entry.date === today) ?? null;
  const dinnerName = `Features soup ${tag}`;
  await app.ctx.meals.setDinner({ date: today, name: dinnerName });
  await idle();
  await until(() => app.mealsState?.dinners.some((entry) => entry.name === dinnerName), "tonight's dinner is planned");
  const noteId = crypto.randomUUID().replaceAll("-", "");
  const noteTitle = `Features note ${tag}`;
  await app.ctx.records.saveNote("create-note", { title: noteTitle, body: "Kept while hidden.", areaId: null, noteId });
  await idle();
  app.ctx.navigation.navigate("#today");
  await until(() => visible(app.tonight) && app.tonight.textContent.includes(dinnerName), "Today shows tonight's dinner", () => app.tonight.textContent);
  check(visible(app.pages.get("today").querySelector(".today-fridge-link")), "Today links to the fridge");
  const startRevision = features.revision;

  // The admin's page: every feature with a plain description and a switch.
  app.ctx.navigation.navigate("#household/features");
  const page = app.householdFeatures;
  await until(() => !app.pages.get("household").hidden && visible(page), "Household › Features shows");
  check(segments("household").includes("features"), "Features is a Household segment", segments("household"));
  check(page.value.admin && page.value.local, "a household that doesn't sync decides on this device", page.value);
  const switches = [...page.querySelectorAll("input.features-switch")];
  // One switch per feature in web/features.js, however many there are.
  const featureCount = (await import("/features.js")).FEATURES.length;
  check(switches.length === featureCount && switches.every((input) => input.checked && input.getAttribute("role") === "switch"), "one switch per feature, all on", [switches.length, featureCount]);
  for (const input of switches) {
    const label = page.querySelector(`label[for="${input.id}"]`);
    const description = document.getElementById(input.getAttribute("aria-describedby"));
    check(label?.textContent && description?.textContent.endsWith("."), "each switch is named and described", input.id);
  }
  check(/Always on: Today, Lists \(To do and Shopping\), Updates \(handoffs\) and Household\./.test(page.textContent), "the page names what is always on");
  const save = page.querySelector(".features-save");
  check(save.disabled, "nothing to save yet");
  for (const id of OFF) {
    const input = page.querySelector(`#household-feature-${id}`);
    input.checked = false;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }
  check(!page.querySelector(".features-save").disabled, "a change can be saved");
  page.querySelector(".features-save").click();
  await until(() => !features.isOn("meals") && !page.busy, "the change is saved");
  check(page.querySelector(".features-feedback").textContent === "Features saved.", "the page says so", page.querySelector(".features-feedback").textContent);
  check(features.revision === startRevision + 1, "a new revision");
  check(app.featuresNote.hidden, "the person who made the change gets no note");
  check(document.documentElement.dataset.kinFeaturesOff === "fridge meals routines notes", "the layout knows what is off", document.documentElement.dataset.kinFeaturesOff);

  // Another member's device: the same set arrives from the service, after
  // one where everything was on.
  const off = features.off;
  features.receive({ off: 0, revision: features.revision + 1, admin: false });
  features.receive({ off, revision: features.revision + 1, admin: false });
  app.ctx.navigation.navigate("#today");
  await until(() => !app.pages.get("today").hidden, "Today shows");
  const note = app.featuresNote;
  await until(() => visible(note), "the one-time note shows on Today");
  check(note.querySelector(".features-note-text").textContent ===
    "Your household turned off Fridge, Meals, Routines and Notes & reference. Nothing was deleted; a household admin can turn them back on under Household › Features.",
  "the note is calm and plain", note.textContent);
  // Navigation.
  check(!visible(app.navLinks.get("routines")), "Routines leaves the navigation");
  check(["today", "lists", "updates", "household"].every((id) => visible(app.navLinks.get(id))), "the always-on destinations stay");
  check(!segments("lists").includes("meals") && segments("lists").includes("shopping"), "Meals leaves Lists", segments("lists"));
  check(!segments("household").includes("fridge") && !segments("household").includes("notes"), "the Fridge and Notes leave Household", segments("household"));
  check(![...app.pages.get("household").querySelectorAll(".hub-link")].some((link) => visible(link) && /fridge|notes/.test(link.getAttribute("href"))), "and the hub's links");
  // Today.
  check(!visible(app.tonight), "no tonight's dinner on Today");
  check(!visible(app.pages.get("today").querySelector(".today-fridge-link")), "no fridge link on Today");
  check(!visible(app.today.querySelector(".today-routines")), "no routines on Today");
  check(visible(app.pages.get("today").querySelector(".today-week-link")), "This week stays");
  // Routes into them open Today with a calm line.
  for (const [hash, label] of [["#household/fridge", "Fridge"], ["#lists/meals", "Meals"], ["#routines", "Routines"], ["#household/notes", "Notes & reference"]]) {
    app.ctx.navigation.navigate(hash);
    check(app.route.canonical === "today" && location.hash === "#today", `${hash} opens Today`, app.route.canonical);
    check(app.status.textContent === `${label} is turned off in your household, so Kin opened Today.`, `${hash} says why`, app.status.textContent);
  }
  // Search.
  app.ctx.navigation.navigate("#search");
  const search = app.search;
  search.queryInput.value = noteTitle;
  search.queryInput.dispatchEvent(new Event("input", { bubbles: true }));
  await frame();
  check(!search.resultsList.textContent.includes(noteTitle), "Search doesn't find the note", search.resultsList.textContent);
  // Quick add: no repeating tasks (Routines).
  app.ctx.navigation.navigate("#today");
  app.quickAdd.open();
  await until(() => app.quickAdd.dialog.open, "Quick add opens");
  check(app.quickAdd.repeat.hidden, "Quick add offers no repeat without Routines");
  app.quickAdd.cancelButton.click();
  // The Features page is read-only for a member.
  app.ctx.navigation.navigate("#household/features");
  await until(() => visible(page), "the member sees the Features page");
  check(!page.querySelector("input") && !visible(page.querySelector(".features-save")), "no switches for a member");
  check(/Ask a household admin/.test(page.textContent), "it says whom to ask");
  check(page.querySelector('[data-feature-id="meals"] .features-state').textContent === "Off" &&
    page.querySelector('[data-feature-id="chat"] .features-state').textContent === "On", "and what is on and off");
  // The note is shown once.
  app.ctx.navigation.navigate("#today");
  note.querySelector(".features-note-ok").click();
  check(note.hidden, "OK puts the note away");
  features.receive({ off, revision: features.revision, admin: false });
  check(note.hidden, "and it doesn't come back");

  // Back as the admin: everything on again, and nothing was lost.
  features.receive({ off, revision: features.revision + 1, admin: true });
  app.ctx.navigation.navigate("#household/features");
  await until(() => page.querySelectorAll("input.features-switch").length === featureCount, "the admin's switches are back");
  for (const id of OFF) {
    const input = page.querySelector(`#household-feature-${id}`);
    check(!input.checked, `${id} shows off`);
    input.checked = true;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }
  page.querySelector(".features-save").click();
  await until(() => features.off === 0 && !page.busy, "everything is on again");
  check(document.documentElement.dataset.kinFeaturesOff === undefined, "nothing is hidden");
  check(segments("lists").includes("meals") && segments("household").includes("fridge") && segments("household").includes("notes"), "the segments are back");
  check(visible(app.navLinks.get("routines")), "Routines is back in the navigation");
  app.ctx.navigation.navigate("#household/fridge");
  check(app.route.canonical === "household/fridge", "the Fridge opens again");
  app.ctx.navigation.navigate("#today");
  await until(() => visible(app.tonight) && app.tonight.textContent.includes(dinnerName), "tonight's dinner is back on Today", () => app.tonight.textContent);
  check(visible(app.today.querySelector(".today-routines")), "routines are back on Today");
  app.ctx.navigation.navigate("#search");
  search.queryInput.value = noteTitle;
  search.queryInput.dispatchEvent(new Event("input", { bubbles: true }));
  await until(() => search.resultsList.textContent.includes(noteTitle), "Search finds the note again");
  app.ctx.navigation.navigate("#lists/meals");
  check(app.route.canonical === "lists/meals", "Meals opens again");
  check(document.documentElement.scrollWidth <= innerWidth, "nothing scrolls sideways");

  // Tidy up.
  if (previousDinner) await app.ctx.meals.setDinner({ date: today, recipeId: previousDinner.recipeId ?? null, name: previousDinner.name });
  else await app.ctx.meals.clearDinner(today);
  await idle();
  await app.ctx.records.saveNote("archive-note", { noteId });
  await idle();
  app.ctx.undo.clear();
  app.ctx.navigation.navigate("#today");
  return "PASS household features: an admin turns off Meals, Fridge, Routines and Notes on Household › Features; a member's device hides them from navigation, Today, Search and Quick add, their routes open Today with a calm line, a one-time note, a read-only page; on again, the dinner and the note are back (#623–#626)";
}
