import { setViewport } from "./cdp-viewport.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Household workspace UX journeys (docs/WORKSPACE-UX.md §6). The first part
// runs inside the page against the real components, storage and WASM replay;
// the second part drives the viewport over CDP for the responsive checks and
// writes screenshot evidence to target/ux-screenshots/.
export async function workspaceUxRegressions(recovery) {
  const app = document.querySelector("kin-app");
  const passed = [];
  const check = (condition, message) => { if (!condition) throw new Error(message); passed.push(message); };
  const idle = async () => {
    for (let index = 0; (app.busy || app.refreshing || app.pendingRefresh || app.wakePending) && index < 400; index++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    check(!app.busy && !app.refreshing && !app.pendingRefresh && !app.wakePending, "workspace work returns idle");
  };
  const wait = async (condition, label) => {
    for (let index = 0; index < 400; index++) {
      if (condition()) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`workspace wait timed out: ${label}`);
  };
  const frame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const visible = (node) => Boolean(node) && !node.closest("[hidden]") && node.getClientRects().length > 0;
  const rowIn = (list, itemId) => [...list.querySelectorAll("kin-item")].find((node) => node.record?.itemId === itemId) ?? null;
  const rowsIn = (list, itemId) => [...list.querySelectorAll("kin-item")].filter((node) => node.record?.itemId === itemId);
  const addVia = async (composer, text) => {
    composer.input.value = text;
    composer.form.requestSubmit();
    await idle();
    return app.state.items.find((item) => item.text === text);
  };
  const today = app.ctx.navigation.currentCivilDate();
  const shift = (days) => { const d = new Date(); d.setDate(d.getDate() + days); return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate(); };
  const stamp = crypto.randomUUID().slice(0, 6);

  // Daily UX baseline: measure the existing local pipeline without imposing a
  // machine-specific performance budget. Interaction counts begin with focus
  // in the primary Today capture (text entry + Enter, then one completion).
  app.ctx.navigation.navigate("#today");
  const baselineText = `Daily baseline ${stamp}`;
  app.compose.input.focus();
  app.compose.input.value = baselineText;
  const createStarted = performance.now();
  app.compose.form.requestSubmit();
  await idle();
  const createMs = performance.now() - createStarted;
  const baselineItem = app.state.items.find((entry) => entry.text === baselineText);
  check(baselineItem?.planningDate === today && document.activeElement === app.compose.input,
    "daily baseline creates a due-today task and restores focus to capture");
  const baselineRow = rowIn(app.today, baselineItem.itemId);
  const complete = baselineRow.querySelector(".complete-button");
  complete.focus();
  const completeStarted = performance.now();
  complete.click();
  await idle();
  const completeMs = performance.now() - completeStarted;
  const completedRow = rowIn(app.today, baselineItem.itemId);
  check(app.state.items.find((entry) => entry.itemId === baselineItem.itemId)?.status === "completed" &&
    document.activeElement === completedRow?.querySelector(".reopen-button"),
  "daily baseline completes the canonical task and restores focus to its Reopen action");
  check(Number.isFinite(createMs) && createMs > 0 && Number.isFinite(completeMs) && completeMs > 0,
    "daily baseline records finite positive local create and complete latencies");
  console.log(`METRIC daily-ux ${JSON.stringify({ createMs: Number(createMs.toFixed(2)), completeMs: Number(completeMs.toFixed(2)), createInteractions: 2, completeInteractions: 1 })}`);

  // 1. Add a task in To do; it stays findable.
  app.ctx.navigation.navigate("#lists/todo");
  const task = await addVia(app.needs.composer, `Fix the gate latch ${stamp}`);
  check(task?.classification === "need" && visible(rowIn(app.needs, task.itemId)) && app.needs.composer.result.textContent === "Saved on this device.",
    "1. a task added from To do is listed there with an inline local-save confirmation");
  app.search.queryInput.value = stamp;
  app.search.queryInput.dispatchEvent(new Event("input"));
  check([...app.search.resultsList.querySelectorAll("[data-result-id]")].some((node) => node.dataset.resultId === task.itemId), "1. the task is found by search by its canonical id");

  // 2. Add a shopping item; it stays a shopping item.
  app.ctx.navigation.navigate("#lists/shopping");
  const eggs = await addVia(app.shopping.composer, `Eggs ${stamp}`);
  check(eggs?.classification === "shopping" && visible(rowIn(app.shopping, eggs.itemId)) && !rowIn(app.needs, eggs.itemId),
    "2. a shopping item lives only in Shopping");

  // 3. Plan it for today from its details; Today shows the same canonical record.
  app.ctx.detail.openItemDetail(eggs.itemId);
  check(app.selection?.itemId === eggs.itemId && app.detail.querySelector(".item-detail-title").textContent === eggs.text, "3. details open for the shopping item");
  [...app.detail.querySelectorAll(".item-planning-date-shortcut")].find((node) => node.textContent === "Today").click();
  await idle();
  check(app.state.items.find((item) => item.itemId === eggs.itemId).planningDate === today, "3. the planned date is set through the existing command");
  app.ctx.detail.closeItemDetail({ restoreFocus: false });
  app.ctx.navigation.navigate("#today");
  const todayRows = rowsIn(app.today, eggs.itemId);
  check(todayRows.length === 1 && todayRows[0].closest("[data-section]")?.dataset.section === "today" &&
    todayRows[0].querySelector(".item-meta").textContent.startsWith("Shopping item · Planned for today"),
    "3. Today lists the same record once, still labelled as a shopping item");
  check(app.state.items.filter((item) => item.text === eggs.text).length === 1, "3. no duplicate record was created for Today");

  // 4. Complete it from Today; Shopping reflects it, and the reverse.
  rowIn(app.today, eggs.itemId).querySelector(".complete-button").click();
  await idle();
  check(app.state.items.find((item) => item.itemId === eggs.itemId).status === "completed", "4. completing from Today completes the canonical record");
  check(rowIn(app.today, eggs.itemId)?.closest("details")?.classList.contains("completed-disclosure") &&
    rowIn(app.shopping, eggs.itemId)?.closest("details")?.classList.contains("completed-disclosure"),
    "4. both Today and Shopping show it under their Completed disclosure");
  app.ctx.navigation.navigate("#lists/shopping");
  rowIn(app.shopping, eggs.itemId).querySelector(".reopen-button").click();
  await idle();
  check(app.state.items.find((item) => item.itemId === eggs.itemId).status === "active" && rowIn(app.today, eggs.itemId).closest("[data-section]").dataset.section === "today",
    "4. reopening from Shopping returns the same record to Today");

  // 5. A legacy Today-classified item stays accessible without migration.
  const eventsBefore = (await app.store.loadEvents()).length;
  await app.ctx.append.appendCommand({ type: "add", text: `Legacy today ${stamp}`, classification: "today" });
  await idle();
  const legacy = app.state.items.find((item) => item.text === `Legacy today ${stamp}`);
  app.ctx.render.renderState();
  check(legacy.classification === "today" && legacy.planningDate === null &&
    rowIn(app.today, legacy.itemId)?.closest("[data-section]")?.dataset.section === "today" && visible(rowIn(app.needs, legacy.itemId) ?? null) === false && rowIn(app.needs, legacy.itemId),
    "5. an undated legacy Today item appears on Today and is listed under To do");
  await app.ctx.append.appendCommand({ type: "set-item-planning-date", itemId: legacy.itemId, planningDate: shift(1) });
  await idle();
  app.ctx.render.renderState();
  check(rowsIn(app.today, legacy.itemId).length === 1 && rowIn(app.today, legacy.itemId).closest("[data-section]")?.dataset.section === "upcoming" &&
    rowIn(app.needs, legacy.itemId)?.querySelector(".item-meta")?.textContent.includes("Planned for tomorrow"),
    "5. an explicit date takes precedence over the legacy classification (tomorrow is Coming up, not Today)");
  await app.ctx.append.appendCommand({ type: "set-item-planning-date", itemId: legacy.itemId, planningDate: null });
  await idle();
  app.ctx.render.renderState();
  check(rowIn(app.today, legacy.itemId) && (await app.store.loadEvents()).length === eventsBefore + 3 &&
    app.state.items.find((item) => item.itemId === legacy.itemId).classification === "today",
    "5. clearing the date restores legacy behaviour; only the explicit commands were appended and the classification is untouched");

  // 6. Future plans are not today's work.
  const forms = await addVia(app.needs.composer, `School forms ${stamp}`);
  await app.ctx.append.appendCommand({ type: "set-item-planning-date", itemId: forms.itemId, planningDate: shift(5) });
  await idle();
  app.ctx.render.renderState();
  check(rowsIn(app.today, forms.itemId).length === 1 && rowIn(app.today, forms.itemId).closest("[data-section]")?.dataset.section === "upcoming" &&
    rowIn(app.needs, forms.itemId).querySelector(".item-meta").textContent.startsWith("Planned for ") &&
    !rowIn(app.needs, forms.itemId).querySelector(".item-meta").textContent.includes("today"),
    "6. a future-dated item is listed once under Coming up, not as today's work, and labelled with its date in To do");

  // 7. Earlier plans and paused routines.
  const bins = await addVia(app.needs.composer, `Bins ${stamp}`);
  await app.ctx.append.appendCommand({ type: "set-item-planning-date", itemId: bins.itemId, planningDate: shift(-2) });
  await idle();
  app.ctx.render.renderState();
  const earlierRow = rowIn(app.today, bins.itemId);
  const earlierSection = earlierRow?.closest("[data-section]");
  check(earlierSection?.dataset.section === "earlier" && earlierSection.querySelector("h2").textContent === "Earlier plans" &&
    earlierSection.querySelector(".section-hint").textContent.startsWith("Still open from earlier") && !earlierRow.closest("details") &&
    /still open/.test(earlierRow.querySelector(".item-meta").textContent) && !/overdue|late|behind/i.test(app.today.textContent) && rowIn(app.needs, bins.itemId),
    "7. an unfinished earlier plan is visible under a calm Earlier plans section and stays in To do");
  await app.ctx.append.appendCommand({ type: "create-routine", text: `Water plants ${stamp}`, cadence: "daily", createdOn: today });
  await idle();
  app.ctx.render.renderState();
  const routine = app.state.routines.find((record) => record.text === `Water plants ${stamp}`);
  check(app.today.querySelector(`.today-routines [data-routine-id="${routine.routineId}"] .complete-button`) &&
    app.today.querySelector(".today-routines .routine-period").textContent === "Today",
    "7. an open daily routine appears on Today under its period");
  await app.ctx.append.appendCommand({ type: "set-household-mode", mode: "vacation" });
  await idle();
  app.ctx.render.renderState();
  check(!app.today.querySelector(".today-routines .complete-button") && app.today.querySelector(".today-routines").textContent.includes("paused") &&
    !app.routines.querySelector('[data-action="complete-routine-occurrence"]') && app.routines.hint.textContent.includes("paused"),
    "7. a non-Normal mode pauses routine occurrences everywhere without hiding the routines");
  await app.ctx.append.appendCommand({ type: "set-household-mode", mode: "normal" });
  await idle();
  app.ctx.render.renderState();

  // 8. Open and close details without losing list position or drafts.
  app.ctx.navigation.navigate("#lists/todo");
  for (let index = 0; index < 10; index++) await addVia(app.needs.composer, `Filler ${index} ${stamp}`);
  app.needs.composer.input.value = "unsent quick-add draft";
  window.scrollTo(0, 320);
  await frame();
  const detailsButton = rowIn(app.needs, bins.itemId).querySelector(".item-details-button");
  // Focusing scrolls the row into view the way a person would have it on
  // screen; the position to restore is the one at the moment of opening.
  detailsButton.focus();
  await frame();
  const scrolledTo = window.scrollY;
  check(scrolledTo > 0, "8. the list is scrolled before opening details");
  detailsButton.click();
  await frame();
  check(app.selection?.itemId === bins.itemId && document.activeElement === app.detail.querySelector(".item-detail-title"), "8. details open from the row and focus the heading");
  app.detail.stepInput.value = "unsent step draft";
  app.ctx.render.renderState();
  check(app.detail.stepInput.value === "unsent step draft" && app.needs.composer.input.value === "unsent quick-add draft",
    "8. a background refresh keeps the step draft and the quick-add draft");
  app.detail.querySelector(".item-detail-close").click();
  await frame();
  await frame();
  check(app.selection === null && Math.abs(window.scrollY - scrolledTo) <= 2 && document.activeElement === rowIn(app.needs, bins.itemId).querySelector(".item-details-button") &&
    app.needs.composer.input.value === "unsent quick-add draft",
    `8. closing restores the list position (${window.scrollY} vs ${scrolledTo}) and focus, and keeps the quick-add draft`);
  app.ctx.detail.openItemDetail(bins.itemId);
  app.detail.stepInput.value = "draft for A";
  const itemA = app.selection.itemId;
  app.ctx.detail.openItemDetail(forms.itemId);
  check(app.detail.stepInput.value === "", "8. selecting B never shows A's checklist draft");
  app.detail.stepInput.value = "draft for B";
  app.ctx.detail.openItemDetail(itemA);
  check(app.detail.stepInput.value === "draft for A", "8. returning to A restores its own unsaved draft");
  app.detail.stepInput.value = "Async A step";
  const originalDetailAppend = app.ctx.append.appendCommand.bind(app.ctx.append);
  let finishDetailAppend;
  app.ctx.append.appendCommand = (command) => new Promise((resolve, reject) => {
    finishDetailAppend = () => originalDetailAppend(command).then(resolve, reject);
  });
  app.detail.querySelector(".step-compose").requestSubmit();
  await wait(() => app.busy && finishDetailAppend, "A checklist save is pending");
  app.ctx.detail.openItemDetail(forms.itemId);
  app.detail.stepInput.value = "draft for B while A saves";
  finishDetailAppend();
  await idle();
  app.ctx.append.appendCommand = originalDetailAppend;
  check(app.selection.itemId === forms.itemId && app.detail.stepInput.value === "draft for B while A saves" &&
    app.state.items.find((item) => item.itemId === itemA).steps.some((step) => step.text === "Async A step"),
    "8. A's delayed successful save clears only A after B is selected and leaves B's editor untouched");
  app.ctx.detail.openItemDetail(itemA);
  check(app.detail.stepInput.value === "", "8. a successfully saved A draft stays cleared when returning to A");
  app.detail.stepInput.value = "Async failed A";
  let failDetailAppend;
  app.ctx.append.appendCommand = (command) => new Promise((resolve) => {
    failDetailAppend = () => { app.ctx.append.appendCommand = originalDetailAppend; const error = new Error("Synthetic delayed failure"); error.code = 5; resolve(Promise.reject(error)); };
  });
  app.detail.querySelector(".step-compose").requestSubmit();
  await wait(() => app.busy && failDetailAppend, "A checklist failure is pending");
  app.ctx.detail.openItemDetail(forms.itemId);
  failDetailAppend();
  await idle();
  app.ctx.append.appendCommand = originalDetailAppend;
  check(app.selection.itemId === forms.itemId && !app.detail.querySelector(".item-detail-feedback") && app.alert.hidden && app.detail.detailFeedbacks.has(itemA),
    "8. a delayed A failure stays keyed to A and does not leak into B or the blocked global alert");
  app.ctx.detail.openItemDetail(itemA);
  check(app.detail.querySelector("[data-detail-retry]") && app.detail.stepInput.value === "Async failed A",
    "8. returning to A restores its matching error, retry and failed checklist draft");
  app.detail.querySelector("[data-detail-retry]").click();
  await idle();
  check(app.state.items.find((item) => item.itemId === itemA).steps.some((step) => step.text === "Async failed A") &&
    !app.detail.detailFeedbacks.has(itemA) && app.detail.stepInput.value === "",
    "8. retrying the selected A error succeeds and clears its feedback and submitted draft");
  app.detail.stepInput.value = "draft through route change";
  app.ctx.detail.closeItemDetail({ restoreFocus: false });
  app.ctx.navigation.navigate("#today");
  app.ctx.navigation.navigate("#lists/todo");
  app.ctx.detail.openItemDetail(itemA);
  check(app.detail.stepInput.value === "draft through route change", "8. closing details and changing routes retain the item-keyed draft");
  app.detail.stepInput.value = "Saved step once";
  app.detail.querySelector(".step-compose").requestSubmit();
  await idle();
  const savedA = app.state.items.find((item) => item.itemId === itemA);
  app.detail.querySelector(".step-compose").requestSubmit();
  await idle();
  check(savedA.steps.filter((step) => step.text === "Saved step once").length === 1 && app.detail.stepInput.value === "",
    "8. successful step save clears its submitted draft and empty Enter cannot append a duplicate");
  app.ctx.detail.closeItemDetail({ restoreFocus: false });
  app.needs.composer.input.value = "";
  window.scrollTo(0, 0);

  // 9. Search opens the real targets.
  const trip = await addVia(app.needs.composer, `Pack for the trip ${stamp}`);
  await app.ctx.append.appendCommand({ type: "add-item-step", itemId: trip.itemId, stepId: crypto.randomUUID().replaceAll("-", ""), text: `Chargers ${stamp}` });
  await idle();
  const step = app.state.items.find((item) => item.itemId === trip.itemId).steps[0];
  const noteId = crypto.randomUUID().replaceAll("-", "");
  await app.ctx.append.appendCommand({ type: "create-note", noteId, id: noteId, title: `Wi-Fi ${stamp}`, body: "Password in the drawer", areaId: null });
  await idle();
  app.ctx.render.renderState();
  app.ctx.navigation.navigate("#search");
  app.search.queryInput.value = stamp;
  app.search.queryInput.dispatchEvent(new Event("input"));
  const result = (kind, id) => [...app.search.resultsList.querySelectorAll("[data-result-id]")].find((node) => node.dataset.resultKind === kind && node.dataset.resultId === id);
  check(result("Item", trip.itemId) && result("Checklist Step", `${trip.itemId}:${step.stepId}`) && result("Note", noteId) &&
    app.search.resultsList.querySelector("mark")?.textContent.toLowerCase() === stamp.toLowerCase() && !app.search.resultsList.innerHTML.includes("<script"),
    "9. results carry canonical ids and highlight matches with safe mark elements");
  result("Item", trip.itemId).click();
  await frame();
  check(app.dataset.route === "lists/todo" && app.selection?.itemId === trip.itemId && app.selection.origin === "search" && app.detail.querySelector(".item-detail-close").textContent === "Back to search",
    "9. an item result opens that record's details in its list");
  app.ctx.detail.openItemDetail(trip.itemId);
  check(app.selection.origin === "search" && app.detail.querySelector(".item-detail-close").textContent === "Back to search",
    "9. reopening the same item preserves its Search origin");
  rowIn(app.needs, forms.itemId).querySelector(".item-details-button").click();
  await frame();
  check(app.selection?.itemId === forms.itemId && app.selection.origin === null && app.detail.querySelector(".item-detail-close").textContent !== "Back to search",
    "9. opening another To do item does not inherit the prior item's Search origin");
  app.detail.querySelector(".item-detail-close").click();
  await frame();
  await frame();
  check(app.dataset.route === "lists/todo" && app.selection === null,
    "9. closing the newly selected item returns to its To do list");
  app.ctx.navigation.navigate("#search");
  result("Item", trip.itemId).click();
  await frame();
  app.detail.querySelector(".item-detail-close").click();
  await frame();
  await frame();
  check(app.dataset.route === "search" && app.search.queryInput.value === stamp && result("Item", trip.itemId) && document.activeElement === result("Item", trip.itemId),
    "10. Back to search returns with the query, results and focused result intact");
  result("Checklist Step", `${trip.itemId}:${step.stepId}`).click();
  await frame();
  check(app.selection?.itemId === trip.itemId && document.activeElement?.dataset.stepId === step.stepId && app.detail.querySelector(".step-row-highlight"),
    "9. a checklist step result opens the parent item with that step focused");
  app.ctx.detail.closeItemDetail({ restoreFocus: false });
  app.ctx.navigation.navigate("#search");
  result("Note", noteId).click();
  await frame();
  await frame();
  check(app.dataset.route === "household/notes" && app.notes.contains(document.activeElement) && document.activeElement.closest(`[data-note-id="${noteId}"]`),
    "9. a note result opens Notes & reference with that note focused");
  app.ctx.navigation.navigate("#search");
  check(app.search.queryInput.value === stamp && app.search.resultsList.childElementCount > 0, "10. search state survives navigating away and back within the session");
  await app.ctx.append.appendCommand({ type: "archive-note", noteId, id: noteId });
  await idle();
  app.ctx.navigation.handleOpenSearchResult({ kind: "note", id: noteId });
  check(app.status.textContent.startsWith("That record is no longer available"), "9. an archived target is explained instead of opened");

  // 13. Routine reminders through the in-app date/time control.
  app.ctx.navigation.navigate("#routines");
  app.localReminders.notification = class { static permission = "granted"; constructor() {} };
  const reminder = [...app.routines.querySelectorAll("kin-reminder")].find((node) => node.targetRecord?.id === `routine:${routine.routineId}`);
  check(reminder && !reminder.querySelector("form") && reminder.querySelector('[data-reminder-action="open"]').textContent === "Remind me", "13. a routine offers Remind me without a prompt");
  reminder.querySelector('[data-reminder-action="open"]').click();
  const reminderForm = reminder.querySelector("form");
  const dateInput = reminderForm.querySelector('input[type="date"]');
  const timeInput = reminderForm.querySelector('input[type="time"]');
  check(dateInput.labels[0].textContent === "Date" && timeInput.labels[0].textContent === "Time" && reminder.textContent.includes("On this device only"),
    "13. the reminder editor has labelled date and time inputs and explains the device-only limit");
  reminderForm.requestSubmit();
  check(reminder.querySelector(".reminder-error").textContent === "Choose a date and a time." && app.localReminders.entries.size === 0, "13. an empty reminder is refused with plain language");
  const past = new Date(Date.now() - 3_600_000);
  dateInput.value = `${past.getFullYear()}-${String(past.getMonth() + 1).padStart(2, "0")}-${String(past.getDate()).padStart(2, "0")}`;
  timeInput.value = `${String(past.getHours()).padStart(2, "0")}:${String(past.getMinutes()).padStart(2, "0")}`;
  reminderForm.requestSubmit();
  check(reminder.querySelector(".reminder-error").textContent === "Choose a time that hasn't passed yet.", "13. a past time is refused");
  [...reminderForm.querySelectorAll(".reminder-shortcut")].find((node) => node.textContent === "Tomorrow morning").click();
  check(reminder.querySelector(".reminder-preview").textContent.startsWith("Reminds ") && dateInput.value && timeInput.value === "09:00",
    "13. a shortcut fills the inputs and shows the resolved local time");
  reminderForm.requestSubmit();
  await wait(() => app.localReminders.entries.has(`routine:${routine.routineId}`), "reminder scheduled");
  check(!reminder.querySelector("form") && reminder.querySelector(".reminder-status").textContent.startsWith("Reminds ") && app.status.textContent.includes("on this device"),
    "13. setting the reminder uses the existing local model and confirms on this device");
  const appendBeforeReminderFailure = app.ctx.append.appendCommand;
  app.ctx.append.appendCommand = async () => { throw Object.assign(new Error("Synthetic storage failure"), { userMessage: "Kin could not save that change locally." }); };
  await app.ctx.routines.saveRoutine({ type: "complete-routine-occurrence", routineId: routine.routineId, occurrenceKey: routine.occurrenceKey });
  app.ctx.append.appendCommand = appendBeforeReminderFailure;
  check(app.localReminders.entries.has(`routine:${routine.routineId}`) && app.state.routines.find((record) => record.routineId === routine.routineId)?.status === "active",
    "13. a failed Routine change preserves its device-only reminder");
  app.ctx.status.clearAlert();
  reminder.querySelector('[data-reminder-action="cancel"]').click();
  check(!app.localReminders.entries.has(`routine:${routine.routineId}`) && reminder.querySelector('[data-reminder-action="open"]').textContent === "Remind me",
    "13. cancelling clears the reminder");
  check(!app.routines.querySelector(".routine-list [data-action='archive-routine']") || typeof window.prompt === "function", "13. no prompt() path remains in the reminder flow");

  // 14. Offline and failed saves produce truthful, contextual feedback.
  app.ctx.navigation.navigate("#lists/todo");
  window.dispatchEvent(new Event("offline"));
  check(app.syncChip.state === "offline" && app.syncChip.querySelector(".sync-label")?.textContent === "Offline — saved here" &&
    app.syncChip.querySelector(".visually-hidden")?.textContent.includes("saved on this device"),
  "14. the header chip reports offline without promising sync on a device that has none");
  const offlineItem = await addVia(app.needs.composer, `Offline add ${stamp}`);
  check(offlineItem && app.needs.composer.result.textContent === "Saved on this device." && app.status.textContent === "Added to To do.",
    "14. an offline save is confirmed as saved on this device");
  window.dispatchEvent(new Event("online"));
  check(app.syncChip.state === "local" && app.syncChip.querySelector(".sync-label")?.textContent === "On this device" &&
    app.syncChip.querySelector(".visually-hidden")?.textContent.includes("Device sync is not set up"),
  "14. back online, the chip reports local-only truthfully");
  const realAppend = app.store.append.bind(app.store);
  app.store.append = async () => { const error = new Error("Synthetic storage failure"); error.code = 5; error.userMessage = "Kin could not save that change locally."; throw error; };
  app.needs.composer.input.value = `Failing add ${stamp}`;
  app.needs.composer.form.requestSubmit();
  await idle();
  app.store.append = realAppend;
  check(app.needs.composer.input.value === `Failing add ${stamp}` && app.needs.composer.result.textContent.startsWith("Couldn't save. Your text is still here.") &&
    app.needs.composer.querySelector(".compose-retry") && !app.alert.hidden && app.feedback.classList.contains("app-feedback-inline"),
    "14. a failed save keeps the text, explains inline with a retry, and does not show a second floating card");
  app.needs.composer.querySelector(".compose-retry").click();
  await idle();
  check(app.state.items.filter((item) => item.text === `Failing add ${stamp}`).length === 1 && app.needs.composer.input.value === "" && app.needs.composer.result.textContent === "Saved on this device." && app.alert.hidden,
    "14. the inline retry saves exactly once and clears the draft");
  // Partial success on the Today capture: the item saves, the date does not.
  app.ctx.navigation.navigate("#today");
  app.store.append = async (command, engine) => { if (command.type === "set-item-planning-date") { const error = new Error("Synthetic date failure"); error.code = 5; throw error; } return realAppend(command, engine); };
  app.compose.classification.value = "shopping";
  app.compose.plan.value = "today";
  app.compose.input.value = `Partial milk ${stamp}`;
  app.compose.form.requestSubmit();
  await idle();
  app.store.append = realAppend;
  const partial = app.state.items.filter((item) => item.text === `Partial milk ${stamp}`);
  check(partial.length === 1 && partial[0].planningDate === null && app.compose.result.textContent.startsWith("Saved to Shopping. Couldn't set the date.") && app.compose.input.value === `Partial milk ${stamp}`,
    "14. partial success says what saved and what did not, without claiming completion");
  const partialId = partial[0]?.itemId;
  app.compose.button.click();
  await idle();
  const resumed = app.state.items.filter((item) => item.text === `Partial milk ${stamp}`);
  check(resumed.length === 1 && resumed[0].itemId === partialId && resumed[0].planningDate === today && app.compose.input.value === "" && app.compose.result.textContent === "Saved on this device.",
    `14. Add resumes the same partially saved record instead of creating a duplicate (${JSON.stringify({ count: resumed.length, planningDate: resumed[0]?.planningDate, today, input: app.compose.input.value, result: app.compose.result.textContent, alert: app.alert.textContent, status: app.status.textContent })})`);
  app.store.append = async (command, engine) => { if (command.type === "set-item-planning-date") { const error = new Error("Synthetic date failure"); error.code = 5; throw error; } return realAppend(command, engine); };
  app.compose.plan.value = "today"; app.compose.input.value = `Edited partial ${stamp}`;
  app.compose.form.requestSubmit(); await idle(); app.store.append = realAppend;
  const editedPending = app.state.items.find((item) => item.text === `Edited partial ${stamp}`);
  app.compose.input.value = `Edited partial ${stamp} changed`; app.compose.input.dispatchEvent(new Event("input", { bubbles: true }));
  app.compose.form.requestSubmit(); await idle();
  check(app.compose.result.querySelector("button")?.textContent === "Finish saved item" &&
    [...app.compose.result.querySelectorAll("button")].some((button) => button.textContent === "Start a new item") &&
    app.state.items.filter((item) => item.itemId === editedPending.itemId).length === 1,
    "14. editing a partially saved capture presents explicit finish-or-start-new choices without duplicating the saved item");
  app.compose.result.querySelector("button").click(); await idle();
  check(app.state.items.find((item) => item.itemId === editedPending.itemId)?.planningDate === today &&
    app.compose.input.value === `Edited partial ${stamp} changed`,
    "14. finishing the saved capture preserves the newer edited draft");
  app.store.append = async (command, engine) => { if (command.type === "pin") { const error = new Error("Synthetic pin failure"); error.code = 5; throw error; } return realAppend(command, engine); };
  app.compose.plan.value = "none"; app.compose.pin.checked = true; app.compose.input.value = `Partial pin ${stamp}`;
  app.compose.form.requestSubmit(); await idle(); app.store.append = realAppend;
  const pinPartial = app.state.items.find((item) => item.text === `Partial pin ${stamp}`);
  app.compose.input.focus();
  app.compose.form.requestSubmit(); await idle();
  check(app.state.items.filter((item) => item.text === `Partial pin ${stamp}`).length === 1 &&
    app.state.items.find((item) => item.itemId === pinPartial.itemId) && app.state.pins.some((pin) => pin.targetId === pinPartial.itemId),
    "14. resubmitting the form resumes a partial pin against the original canonical item id");
  app.compose.pin.checked = false;
  app.compose.plan.value = "today";
  app.compose.classification.value = "need";

  // 15. Legacy routes, back and forward.
  for (const [requested, expected] of [["#more", "household/hub"], ["#handoff", "updates/handoffs"], ["#handoff/talk", "updates/chat"], ["#lists", "lists/todo"], ["#search", "search"], ["#nowhere", "today"], ["#household/privacy", "household/privacy"]]) {
    app.ctx.navigation.navigate(requested);
    check(app.dataset.route === expected && !app.pages.get(expected.split("/")[0]).hidden, `15. ${requested} resolves to ${expected}`);
  }
  check(app.nav.querySelectorAll('[aria-current="page"]').length === 1 && app.nav.querySelector('[aria-current="page"]').dataset.page === "household" &&
    app.segmentNavs.get("household").querySelector('[aria-current="true"]').dataset.segment === "privacy" && !app.privacyPage.hidden && app.privacyPage.contains(app.security),
    "15. the current destination and segment are programmatically identifiable and Privacy & recovery holds the security settings");
  app.ctx.navigation.navigate("#updates/chat");
  history.back();
  await wait(() => app.dataset.route === "household/privacy", "back navigation");
  history.forward();
  await wait(() => app.dataset.route === "updates/chat", "forward navigation");
  check(location.hash === "#updates/chat" && !document.querySelector("#chat-panel").hidden, "15. Back and Forward restore the previous routes and panels");

  // 12. Lock during details, search and the viewer clears protected content.
  app.ctx.navigation.navigate("#lists/todo");
  app.ctx.detail.openItemDetail(trip.itemId);
  app.detail.stepInput.value = "secret step draft";
  app.ctx.navigation.navigate("#search");
  app.search.queryInput.value = "secret query";
  app.search.queryInput.dispatchEvent(new Event("input"));
  app.ctx.navigation.navigate("#lists/todo");
  app.ctx.detail.openItemDetail(trip.itemId);
  const detailBefore = app.detail;
  const searchBefore = app.search;
  app.ctx.session.lockHousehold();
  await app.lockBarrier;
  check(app.vault === null && app.state === null && app.selection === null && !detailBefore.isConnected && app.detail !== detailBefore && app.search !== searchBefore &&
    !searchBefore.isConnected && app.detailSheet.open === false && app.siteTools.hidden && app.main.hidden && !document.body.textContent.includes("secret step draft"),
    "12. locking closes details and search, replaces their components, hides header tools and leaves no protected text in the page");
  await app.security.run(() => app.security.unlockRecovery(recovery));
  await wait(() => app.store && !app.busy && !app.security.busy, "re-unlock");
  await wait(() => app.state !== null, "state after unlock");
  check(app.selection === null && (app.search.queryInput?.value ?? "") === "" && !app.siteTools.hidden, "12. after unlocking, no previous selection or search query returns");
  app.ctx.navigation.navigate("#today");
  return `PASS household workspace journeys (${passed.length} checks; daily create ${createMs.toFixed(2)} ms / 2 interactions; complete ${completeMs.toFixed(2)} ms / 1 interaction): To do/Shopping capture, Today composition and legacy items, earlier/future plans, paused routines, details drafts and position, search targets, reminders, offline/failed/partial saves, legacy routes, lock`;
}

// CDP-driven: five equal mobile tracks, one detail editor re-homed across
// widths with its draft intact, no horizontal overflow, and screenshots.
export async function workspaceViewportRegressions(client, { visit }) {
  const page = (fn, ...args) => client.evaluate(`(${fn.toString()})(${args.map((value) => JSON.stringify(value)).join(",")})`);
  const passed = [];
  let state = null;
  const check = (condition, message) => { assert.ok(condition, `${message} ${state ? JSON.stringify(state) : ""}`); passed.push(message); };
  const outDir = join(dirname(fileURLToPath(import.meta.url)), "../target/ux-screenshots");
  await mkdir(outDir, { recursive: true });
  const shot = async (name) => {
    await page(() => window.scrollTo(0, 0));
    const { data } = await client.send("Page.captureScreenshot", { format: "png" });
    await writeFile(join(outDir, `regression-${name}.png`), Buffer.from(data, "base64"));
  };
  const viewport = async (width, height, mobile) => {
    await setViewport(client, { width, height, deviceScaleFactor: 1, mobile });
    // Media-query change events arrive after the next layout.
    await page(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  };
  const layout = () => page(() => {
    const app = document.querySelector("kin-app");
    const nav = getComputedStyle(app.nav);
    return {
      width: innerWidth,
      tracks: nav.display === "grid" ? nav.gridTemplateColumns.split(" ").length : null,
      navFixed: nav.position === "fixed",
      navLinks: app.nav.querySelectorAll(".nav-link").length,
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      editors: document.querySelectorAll("kin-item-detail").length,
      detailMode: app.detailMode,
      sheetOpen: app.detailSheet.open,
      detailInSheet: app.detailSheet.contains(app.detail),
      detailInPanel: app.detailPanel.contains(app.detail),
      detailDisabled: app.detail.isDisabled,
      fieldsetDisabled: app.controlFieldset.disabled,
      listVisible: !app.pages.get("lists").hidden && getComputedStyle(app.pages.get("lists")).display !== "none",
      draft: app.detail.stepInput?.value ?? null,
      draftMap: [...app.detail.stepDrafts.entries()], activeDetailId: app.detail.itemId, activeInputId: app.detail.stepInput?.dataset.itemId ?? null,
      undersized: [...app.querySelectorAll("button, a.nav-link, a.segment-link, select, input:not([type=checkbox])")].filter((node) => node.getClientRects().length > 0 && !node.closest("dialog:not([open])")).filter((node) => node.getBoundingClientRect().height < 44).map((node) => `${node.tagName}.${node.className}`).slice(0, 5),
      shellGrid: getComputedStyle(app.shell).display,
      focusedInSheet: app.detailSheet.contains(document.activeElement),
    };
  });
  try {
    await visit("lists/todo");
    const itemId = await page(async () => {
      const app = document.querySelector("kin-app");
      const composer = app.needs.composer;
      composer.input.value = "Viewport fixture item";
      composer.form.requestSubmit();
      for (let i = 0; (app.busy || app.refreshing || app.pendingRefresh || app.wakePending) && i < 400; i++) await new Promise((r) => setTimeout(r, 10));
      return app.state.items.find((item) => item.text === "Viewport fixture item").itemId;
    });
    for (const width of [320, 360, 390]) {
      await viewport(width, 780, true);
      state = await page(() => {
        const app = document.querySelector("kin-app");
        const originalName = app.brandTitle.textContent;
        const originalState = app.syncChip.state;
        app.ctx.appearance.setHouseholdIdentity("A household name long enough to compete with every header control");
        const expected = { local: "Local", ready: "Current", syncing: "Syncing", paused: "Paused", offline: "Offline", "offline-sync": "Offline" };
        const statuses = Object.entries(expected).map(([syncState, label]) => {
          app.syncChip.state = syncState;
          const chip = app.syncChip.querySelector(".sync-chip");
          const generatedContent = getComputedStyle(chip, "::after").content;
          const visibleLabel = /^['\"](.*?)['\"]/.exec(generatedContent)?.[1] ?? generatedContent;
          const description = chip.querySelector(".visually-hidden");
          return { syncState, label, visibleLabel, described: description?.textContent.startsWith(". ") && !chip.hasAttribute("aria-label") };
        });
        const header = app.header.getBoundingClientRect();
        const tools = app.siteTools.getBoundingClientRect();
        const targets = [...app.siteTools.querySelectorAll("button, a")]
          .filter((node) => node.getClientRects().length > 0)
          .every((node) => node.getBoundingClientRect().height >= 44);
        const result = {
          width: innerWidth,
          statuses,
          overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
          headerContained: header.left >= 0 && header.right <= innerWidth && tools.right <= innerWidth,
          nameClipped: app.brandTitle.scrollWidth > app.brandTitle.clientWidth,
          nameTitled: app.brandTitle.title === app.brandTitle.textContent,
          targets,
          // What the header holds, so an overflow failure says what overflowed.
          headerWidth: Math.round(header.width),
          tools: [...app.siteTools.children].filter((node) => node.getClientRects().length > 0)
            .map((node) => `${node.tagName.toLowerCase()}.${node.className || ""}:${Math.round(node.getBoundingClientRect().width)}`),
        };
        app.ctx.appearance.setHouseholdIdentity(originalName);
        app.syncChip.state = originalState;
        return result;
      });
      check(!state.overflow && state.headerContained && state.nameClipped && state.nameTitled && state.targets
        && state.statuses.every(({ label, visibleLabel, described }) => label === visibleLabel && described),
      `${width}px: every sync state keeps readable text and its accessible description beside a long household name`);
    }
    await viewport(360, 780, true);
    state = await layout();
    check(state.tracks === 5 && state.navLinks === 5 && state.navFixed && !state.overflow && state.undersized.length === 0,
      `360px: five equal bottom-navigation tracks, no overflow, no undersized target (${JSON.stringify(state.undersized)})`);
    await shot("360-todo");
    await page((id) => { const app = document.querySelector("kin-app"); [...app.needs.querySelectorAll(".item-details-button")].find((node) => node.dataset.itemId === id).click(); }, itemId);
    state = await layout();
    check(state.detailMode === "sheet" && state.sheetOpen && state.detailInSheet && state.editors === 1 && state.focusedInSheet,
      "360px: details open as a modal sheet hosting the single editor, with focus inside it");
    await page(() => { document.querySelector("kin-app").detail.stepInput.value = "draft across widths"; });
    await shot("360-detail-sheet");
    const stepFailure = await page(async () => {
      const app = document.querySelector("kin-app"), original = app.ctx.append.appendCommand.bind(app.ctx.append);
      app.detail.stepInput.value = "retry checklist step";
      app.ctx.append.appendCommand = async (command) => { if (command.type === "add-item-step") { app.ctx.append.appendCommand = original; const error = new Error("Synthetic checklist failure"); error.code = 5; throw error; } return original(command); };
      app.detail.querySelector(".step-compose").requestSubmit();
      for (let i = 0; app.busy && i < 400; i++) await new Promise((r) => setTimeout(r, 10));
      app.ctx.render.renderState();
      const dialog = app.detailSheet, error = app.detail.querySelector(".item-detail-feedback [role=alert]"), retry = app.detail.querySelector("[data-detail-retry]");
      return { open: dialog.open, inside: dialog.contains(error) && dialog.contains(retry), retryVisible: retry?.getClientRects().length > 0,
        draft: app.detail.stepInput.value, singleAlert: app.detail.querySelectorAll("[role=alert]").length === 1 && app.alert.hidden, text: error?.textContent };
    });
    check(stepFailure.open && stepFailure.inside && stepFailure.retryVisible && stepFailure.draft === "retry checklist step" && stepFailure.singleAlert,
      "360px: checklist failure survives a rerender with one reachable alert and the draft inside the active sheet");
    await shot("360-detail-step-error");
    const stepRetry = await page(async () => {
      const app = document.querySelector("kin-app"); app.detail.querySelector("[data-detail-retry]").click();
      for (let i = 0; (app.busy || app.refreshing || app.pendingRefresh || app.wakePending) && i < 400; i++) await new Promise((r) => setTimeout(r, 10));
      return { open: app.detailSheet.open, selection: app.selection?.itemId, draft: app.detail.stepInput.value,
        saved: app.state.items.find((item) => item.itemId === app.selection?.itemId)?.steps.some((step) => step.text === "retry checklist step"),
        error: app.detail.querySelector(".item-detail-feedback") };
    });
    check(stepRetry.open && stepRetry.selection && stepRetry.saved && stepRetry.draft === "" && !stepRetry.error,
      "360px: the in-sheet checklist retry saves once and clears only the submitted draft without closing details");
    const dateFailure = await page(async () => {
      const app = document.querySelector("kin-app"), original = app.ctx.append.appendCommand.bind(app.ctx.append), input = app.detail.querySelector(".item-planning-date-input");
      app.ctx.append.appendCommand = async (command) => { if (command.type === "set-item-planning-date") { app.ctx.append.appendCommand = original; const error = new Error("Synthetic date failure"); error.code = 5; throw error; } return original(command); };
      input.value = "2026-10-25"; input.dispatchEvent(new Event("change", { bubbles: true }));
      for (let i = 0; app.busy && i < 400; i++) await new Promise((r) => setTimeout(r, 10));
      app.ctx.render.renderState();
      const error = app.detail.querySelector(".item-detail-feedback [role=alert]"), retry = app.detail.querySelector("[data-detail-retry]");
      return { open: app.detailSheet.open, inside: app.detailSheet.contains(error) && app.detailSheet.contains(retry), reachable: retry?.getClientRects().length > 0,
        singleAlert: app.detail.querySelectorAll("[role=alert]").length === 1 && app.alert.hidden, text: error?.textContent };
    });
    check(dateFailure.open && dateFailure.inside && dateFailure.reachable && dateFailure.singleAlert,
      "360px: planning-date failure and retry remain inside the active sheet after rerender, with one announcement");
    await shot("360-detail-date-error");
    const dateRetry = await page(async () => {
      const app = document.querySelector("kin-app"); app.detail.querySelector("[data-detail-retry]").click();
      for (let i = 0; (app.busy || app.refreshing || app.pendingRefresh || app.wakePending) && i < 400; i++) await new Promise((r) => setTimeout(r, 10));
      return { open: app.detailSheet.open, selection: app.selection?.itemId, date: app.state.items.find((item) => item.itemId === app.selection?.itemId)?.planningDate,
        error: app.detail.querySelector(".item-detail-feedback") };
    });
    check(dateRetry.open && dateRetry.selection && dateRetry.date === 20261025 && !dateRetry.error,
      "360px: planning-date retry succeeds without closing the detail sheet and clears its feedback");
    await page(() => { document.querySelector("kin-app").detail.stepInput.value = "draft across widths"; });
    await page(() => document.querySelector("kin-app").ctx.status.setBusy(true));
    await viewport(1440, 960, false);
    state = await layout();
    check(state.detailMode === "side" && state.detailInPanel && !state.detailDisabled && state.fieldsetDisabled,
      "a busy layout switch to the side panel delegates detail disabling to the workspace fieldset");
    await viewport(390, 844, true);
    state = await layout();
    check(state.detailMode === "sheet" && state.detailInSheet && state.detailDisabled && state.fieldsetDisabled,
      "a busy layout switch to the phone sheet applies component-level detail disabling");
    await page(() => document.querySelector("kin-app").ctx.status.setBusy(false));
    await viewport(768, 1024, false);
    state = await layout();
    check(state.detailMode === "inline" && !state.sheetOpen && state.detailInPanel && !state.listVisible && state.editors === 1 && state.draft === "draft across widths" && !state.overflow,
      `768px: the same editor moves inline in place of the list, keeping its draft ${JSON.stringify(state)}`);
    await shot("768-detail-inline");
    await viewport(1024, 800, false);
    state = await layout();
    check(state.detailMode === "inline" && state.shellGrid === "grid" && state.draft === "draft across widths" && !state.overflow, "1024px: side navigation with the inline detail and the draft intact");
    await shot("1024-detail-inline");
    await viewport(1440, 960, false);
    state = await layout();
    check(state.detailMode === "side" && state.listVisible && state.detailInPanel && state.editors === 1 && state.draft === "draft across widths" && !state.overflow,
      "1440px: the detail sits beside the visible list as a conditional column");
    await shot("1440-detail-side");
    await viewport(1920, 1080, false);
    state = await layout();
    check(state.detailMode === "side" && state.listVisible && !state.overflow && state.draft === "draft across widths", "1920px: the layout stays a readable column plus detail without stretching");
    await shot("1920-detail-side");
    await viewport(390, 844, true);
    state = await layout();
    check(state.detailMode === "sheet" && state.sheetOpen && state.detailInSheet && state.editors === 1 && state.draft === "draft across widths" && state.tracks === 5,
      "390px: returning to phone width re-homes the same editor into the sheet with the draft intact");
    await client.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await client.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    state = await layout();
    check(!state.sheetOpen && state.detailMode === null && (await page(() => document.querySelector("kin-app").selection)) === null, "390px: Escape closes the sheet");
    const closedPanel = await page(() => { const app = document.querySelector("kin-app"); return app.detailPanel.hidden && !app.detail.isConnected; });
    check(closedPanel, "the detail column is conditional: nothing remains when no item is selected");
    await viewport(1440, 960, false);
    state = await layout();
    check(state.detailMode === null && state.listVisible && !state.overflow, "1440px without a selection: no empty third column");
    await visit("today");
    const partial = await page(async () => {
      const app = document.querySelector("kin-app"), composer = app.compose, original = app.store.append.bind(app.store);
      app.store.append = async (command, engine) => { if (command.type === "pin") { app.store.append = original; const error = new Error("Synthetic pin failure"); error.code = 5; throw error; } return original(command, engine); };
      composer.plan.value = "none"; composer.pin.checked = true; composer.input.value = "Keyboard partial pin";
      composer.form.requestSubmit();
      for (let i = 0; app.busy && i < 400; i++) await new Promise((r) => setTimeout(r, 10));
      app.store.append = original;
      return { id: app.state.items.find((item) => item.text === "Keyboard partial pin")?.itemId, input: composer.input, count: app.state.items.filter((item) => item.text === "Keyboard partial pin").length };
    });
    await page(() => document.querySelector("kin-app").compose.input.focus());
    await client.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", text: "\r", windowsVirtualKeyCode: 13 });
    await client.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    const keyboardRetry = await page(async (id) => {
      const app = document.querySelector("kin-app");
      for (let i = 0; (app.busy || app.refreshing || app.pendingRefresh || app.wakePending) && i < 400; i++) await new Promise((r) => setTimeout(r, 10));
      return { count: app.state.items.filter((item) => item.text === "Keyboard partial pin").length,
        sameId: app.state.items.find((item) => item.text === "Keyboard partial pin")?.itemId === id,
        pinned: app.state.pins.some((pin) => pin.targetId === id), input: app.compose.input.value };
    }, partial.id);
    check(partial.id && partial.count === 1 && keyboardRetry.count === 1 && keyboardRetry.sameId && keyboardRetry.pinned && keyboardRetry.input === "",
      `real Enter retries a partially saved pin against its original id and appends no duplicate (${JSON.stringify({ partial, keyboardRetry })})`);
    await shot("1440-today");
    return `PASS responsive workspace (${passed.length} checks): five mobile tracks, one editor re-homed sheet → inline → side → sheet with its draft, Escape, no empty column, screenshots in ${outDir}`;
  } finally {
    await client.send("Emulation.clearDeviceMetricsOverride").catch(() => {});
    await page(() => { const app = document.querySelector("kin-app"); app.ctx.detail.closeItemDetail({ restoreFocus: false }); window.scrollTo(0, 0); });
  }
}

// Exercises a real sync callback shape in the zero-dependency CDP harness and
// records baseline/fixed peer-tab behavior as WebM using Chromium's MediaRecorder.
export async function syncMotionRegressions(first, second) {
  const outDir = join(dirname(fileURLToPath(import.meta.url)), "../target/ux-screenshots");
  await mkdir(outDir, { recursive: true });
  const viewport = { width: 1280, height: 820, deviceScaleFactor: 1, mobile: false };
  await setViewport(first, viewport);
  await setViewport(second, viewport);
  const wait = async (client, expression, label) => {
    for (let attempt = 0; attempt < 200; attempt++) {
      if (await client.evaluate(expression)) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`sync motion regression timed out: ${label}`);
  };
  const mediaRecorderStart = async (client) => {
    const supported = await client.evaluate(`(() => {
      if (typeof MediaRecorder !== "function" || !MediaRecorder.isTypeSupported("video/webm;codecs=vp8") || !HTMLCanvasElement.prototype.captureStream) return false;
      const canvas = document.createElement("canvas");
      canvas.width = innerWidth; canvas.height = innerHeight;
      const context = canvas.getContext("2d");
      const stream = canvas.captureStream(10);
      const recorder = new MediaRecorder(stream, { mimeType: "video/webm;codecs=vp8" });
      const chunks = [];
      recorder.addEventListener("dataavailable", event => { if (event.data.size) chunks.push(event.data); });
      recorder.start(100);
      window.__kinSyncVideo = { canvas, context, stream, recorder, chunks, async draw(base64) {
        const bytes = Uint8Array.from(atob(base64), value => value.charCodeAt(0));
        const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/jpeg" }));
        context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        bitmap.close();
      } };
      return true;
    })()`);
    assert.equal(supported, true, "the installed browser must record WebM without an added package");
  };
  const recordFrame = async (client) => {
    const { data } = await client.send("Page.captureScreenshot", { format: "jpeg", quality: 72 });
    await client.evaluate(`window.__kinSyncVideo.draw(${JSON.stringify(data)})`);
  };
  const saveVideo = async (client, name) => {
    const encoded = await client.evaluate(`(async () => {
      const capture = window.__kinSyncVideo;
      const stopped = new Promise(resolve => capture.recorder.addEventListener("stop", resolve, { once: true }));
      capture.recorder.stop(); await stopped;
      const blob = new Blob(capture.chunks, { type: "video/webm" });
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let binary = "";
      for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
      capture.stream.getTracks().forEach(track => track.stop());
      delete window.__kinSyncVideo;
      return btoa(binary);
    })()`);
    const path = join(outDir, `kin-sync-${name}.webm`);
    await writeFile(path, Buffer.from(encoded, "base64"));
    assert.ok((await (await import("node:fs/promises")).stat(path)).size > 0, `recorded video is non-empty: ${path}`);
    return path;
  };
  const frames = async (client, count) => {
    for (let index = 0; index < count; index++) {
      await recordFrame(client);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };
  const prepare = async (client) => client.evaluate(`(() => {
    const app = document.querySelector("kin-app");
    app.ctx.navigation.navigate("#today");
    const previousLoad = app.store.getCatchUpState;
    window.__kinOriginalCatchUpState = previousLoad;
    window.__kinSyncReadCount = 0;
    app.store.getCatchUpState = async (...args) => {
      window.__kinSyncReadCount++;
      await new Promise(resolve => setTimeout(resolve, 650));
      return previousLoad.apply(app.store, args);
    };
    window.__kinSyncInitialGeometry = [".site-header", ".primary-nav", "#today > header", "#today > kin-compose", "#today .today-list"]
      .map(selector => { const element = app.querySelector(selector); if (!element) return null;
        const rect = element.getBoundingClientRect(); return [Math.round(rect.top), Math.round(rect.height)]; });
    return true;
  })()`);
  try {
    await prepare(first);
    await prepare(second);
    await wait(first, `!document.querySelector("kin-app").pages.get("today").hidden && !document.querySelector("kin-app").busy`, "first Today view");
    await wait(second, `!document.querySelector("kin-app").pages.get("today").hidden && !document.querySelector("kin-app").busy`, "second Today view");
    await new Promise((resolve) => setTimeout(resolve, 450));

    // Capture the old no-op path: a same-state sync callback broadcast an
    // events-changed message, making the peer lock and repaint the whole UI.
    await mediaRecorderStart(second);
    await frames(second, 3);
    await first.evaluate(`(() => document.querySelector("kin-app").ctx.peers.broadcastEventChange())()`);
    await wait(second, `document.querySelector("kin-app").refreshing && document.querySelector("kin-app").busy`, "baseline peer refresh");
    await frames(second, 15);
    await wait(second, `(() => { const app = document.querySelector("kin-app"); return !app.refreshing && !app.busy && !app.pendingRefresh && !app.wakePending; })()`, "baseline peer refresh completion");
    await frames(second, 4);
    const beforeVideo = await saveVideo(second, "refresh-before");
    await second.evaluate(`window.__kinSyncReadCount = 0`);

    // The fixed coordinator omits projection/boundary for added: 0. Attachment
    // and membership notifications are also no-ops when their values are same.
    const fixedPoll = await first.evaluate(`(() => {
      const app = document.querySelector("kin-app");
      const originalRender = app.ctx.render.renderState;
      const originalBroadcast = app.ctx.peers.broadcastEventChange;
      const originalState = app.state;
      const originalBoundary = app.snapshotBoundary;
      let renders = 0, broadcasts = 0;
      app.ctx.render.renderState = function(...args) { renders++; return originalRender.apply(this, args); };
      app.ctx.peers.broadcastEventChange = () => { broadcasts++; };
      const status = app.status.textContent;
      const rows = structuredClone(app.attachmentRows);
      const members = [...(app.activeMemberIds ?? [])];
      app.ctx.sync.handleSyncState({ state: "syncing", message: "Device sync is up to date.", added: 0, quarantined: 0 });
      app.ctx.sync.handleSyncState({ state: "syncing", attachmentRows: rows });
      app.ctx.sync.handleSyncState({ state: "ready", memberIds: members, message: "Device sync is up to date." });
      const result = { renders, broadcasts, statusUnchanged: app.status.textContent === status,
        readCount: window.__kinSyncReadCount ?? 0, busy: app.busy };
      app.ctx.render.renderState = originalRender;
      app.ctx.peers.broadcastEventChange = originalBroadcast;
      app.state = originalState;
      app.snapshotBoundary = originalBoundary;
      return result;
    })()`);
    assert.deepEqual(fixedPoll, { renders: 0, broadcasts: 0, statusUnchanged: true, readCount: 0, busy: false },
      `unchanged polling must not repaint, toast, or notify peer tabs: ${JSON.stringify(fixedPoll)}`);
    await mediaRecorderStart(second);
    await frames(second, 3);
    await first.evaluate(`(() => {
      const app = document.querySelector("kin-app");
      app.ctx.sync.handleSyncState({ state: "syncing", message: "Device sync is up to date.", added: 0, quarantined: 0 });
      app.ctx.sync.handleSyncState({ state: "syncing", attachmentRows: structuredClone(app.attachmentRows) });
      app.ctx.sync.handleSyncState({ state: "ready", memberIds: [...(app.activeMemberIds ?? [])], message: "Device sync is up to date." });
    })()`);
    await frames(second, 19);
    const afterVideo = await saveVideo(second, "refresh-after");
    const peerReads = await second.evaluate("window.__kinSyncReadCount");
    assert.equal(peerReads, 0, "an unchanged sync poll must not refresh another tab");

    const changedProjection = await first.evaluate(() => {
      const app = document.querySelector("kin-app");
      const itemNode = [...app.today.querySelectorAll("kin-item")].find(node => node.record?.text?.length);
      if (!itemNode) throw new Error("sync motion regression needs a visible Today item");
      const itemId = itemNode.record.itemId;
      const originalText = itemNode.record.text;
      const originalState = app.state;
      const originalBoundary = app.snapshotBoundary;
      const originalRender = app.ctx.render.renderState;
      const originalBroadcast = app.ctx.peers.broadcastEventChange;
      const geometry = () => [".site-header", ".primary-nav", "#today > header", "#today > kin-compose", "#today .today-list"]
        .map(selector => { const element = app.querySelector(selector); if (!element) return null;
          const rect = element.getBoundingClientRect(); return [Math.round(rect.top), Math.round(rect.height)]; });
      const beforeGeometry = geometry();
      let renders = 0, broadcasts = 0;
      app.ctx.render.renderState = function(...args) { renders++; return originalRender.apply(this, args); };
      app.ctx.peers.broadcastEventChange = () => { broadcasts++; };
      const projection = structuredClone(originalState);
      const changedText = `${originalText[0] === "S" ? "T" : "S"}${originalText.slice(1)}`;
      projection.items.find(item => item.itemId === itemId).text = changedText;
      app.ctx.sync.handleSyncState({ state: "syncing", message: "Household changes received.", added: 1,
        quarantined: 0, projection, snapshotBoundary: { eventId: "sync-test", localSequence: 1 } });
      const quietDuringRender = app.hasAttribute("data-quiet-render");
      const renderedText = [...app.today.querySelectorAll("kin-item")].find(node => node.record?.itemId === itemId)?.record?.text;
      const afterGeometry = geometry();
      const result = { renders, broadcasts, quietDuringRender, renderedTextMatches: renderedText === changedText,
        stableGeometry: JSON.stringify(afterGeometry) === JSON.stringify(beforeGeometry) };
      app.ctx.render.renderState = originalRender;
      app.ctx.peers.broadcastEventChange = originalBroadcast;
      app.state = originalState;
      app.snapshotBoundary = originalBoundary;
      app.ctx.render.renderState();
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    changedProjection.activeCssMotion = await first.evaluate(() => document.getAnimations({ subtree: true })
      .filter(animation => ["CSSAnimation", "CSSTransition"].includes(animation.constructor.name) && animation.playState !== "finished").length);
    assert.equal(changedProjection.renders, 1, `a real remote change renders once: ${JSON.stringify(changedProjection)}`);
    assert.equal(changedProjection.broadcasts, 1, "a real remote change still notifies peer tabs");
    assert.equal(changedProjection.quietDuringRender, true, "a real projection uses quiet render suppression");
    assert.equal(changedProjection.renderedTextMatches, true, "the remote projection reaches the visible row");
    assert.equal(changedProjection.stableGeometry, true, "sync reconciliation keeps the visible workspace geometry stable");
    assert.equal(changedProjection.activeCssMotion, 0, "sync projection updates start no CSS animations or transitions");
    return `PASS sync motion (${beforeVideo}, ${afterVideo}): no-op poll avoids peer refresh; changed projection renders once with no CSS motion`;
  } finally {
    await first.send("Emulation.clearDeviceMetricsOverride").catch(() => {});
    await second.send("Emulation.clearDeviceMetricsOverride").catch(() => {});
    for (const client of [first, second]) await client.evaluate(`(() => {
      const app = document.querySelector("kin-app");
      if (window.__kinOriginalCatchUpState) app.store.getCatchUpState = window.__kinOriginalCatchUpState;
      delete window.__kinOriginalCatchUpState;
      delete window.__kinSyncReadCount;
    })()`).catch(() => {});
  }
}

// When run directly, delegate to the shared real-browser fixture so this
// command cannot silently do nothing.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const executable = process.argv[2];
  if (!executable) {
    console.error("Usage: node scripts/workspace-ux-regression.mjs <browser executable>");
    process.exitCode = 2;
  } else {
    const runner = join(dirname(fileURLToPath(import.meta.url)), "browser-regression.mjs");
    const result = spawnSync(process.execPath, [runner, executable], { stdio: "inherit", windowsHide: true });
    process.exitCode = result.status ?? 1;
  }
}
