// The family calendar (#660: #661–#664, ADR 0022 §2) in a real browser,
// through the real store and engine. Runs from Node over CDP (it changes the
// viewport); each page step is serialized.
//
// Adds a weekly repeating event with the editor and sees it in the Week and
// Month views; cancels one occurrence and undoes it; moves through days and
// months by keyboard; changes this member's colour and sees it on the
// event; imports a sample .ics file (with a preview first) and imports it
// again without duplicates; marks a countdown and sees it on Today; checks
// 320px has no sideways scroll in every view; and the Day view in easy mode.
import assert from "node:assert/strict";
import { setViewport } from "./cdp-viewport.mjs";

export async function calendarRegressions(client, { until }) {
  const page = (expression) => client.evaluate(expression);
  const settle = () => page(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))`);
  const idle = async () => {
    await until(() => page(`(() => { const app = document.querySelector("kin-app"); return !app.busy && !app.refreshing && !app.pendingRefresh && !app.wakePending && !app.ctx.calendar.loading && !app.ctx.week.reading; })()`));
    await settle();
  };
  const tag = await page(`crypto.randomUUID().slice(0, 6)`);
  const title = `Swimming ${tag}`;

  // ---- Add a weekly repeating event with the editor ------------------------
  await page(`(() => { document.querySelector("kin-app").ctx.navigation.navigate("#week"); return true; })()`);
  await until(() => page(`(() => { const app = document.querySelector("kin-app"); return !app.pages.get("week").hidden && app.calendar.querySelector(".cal-add") && app.week.querySelectorAll(".week-day").length === 7; })()`));
  const shell = await page(`(() => {
    const app = document.querySelector("kin-app");
    return {
      title: app.pages.get("week").querySelector("h1").textContent,
      segments: [...app.segmentNavs.get("week").querySelectorAll(".segment-link")].map((link) => link.textContent.trim()),
      todayMarked: app.navLinks.get("today").getAttribute("aria-current"),
      strip: app.calendar.querySelectorAll(".cal-strip-day").length,
      todayFirst: app.calendar.querySelector(".cal-strip-day")?.getAttribute("aria-current"),
    };
  })()`);
  assert.deepEqual(shell, { title: "Calendar", segments: ["Week", "Day", "Month"], todayMarked: "page", strip: 7, todayFirst: "date" }, `the Calendar page: ${JSON.stringify(shell)}`);
  await page(`(() => { document.querySelector("kin-app").calendar.querySelector(".cal-add").click(); return true; })()`);
  await until(() => page(`document.querySelector("kin-event-editor dialog")?.open === true`));
  const added = await page(`(async () => {
    const app = document.querySelector("kin-app");
    const editor = app.eventEditor;
    const set = (input, value) => { input.value = value; input.dispatchEvent(new Event("input", { bubbles: true })); input.dispatchEvent(new Event("change", { bubbles: true })); };
    const focused = document.activeElement === editor.titleField.input;
    set(editor.titleField.input, ${JSON.stringify(title)});
    editor.allDay.input.checked = false;
    editor.allDay.input.dispatchEvent(new Event("change", { bubbles: true }));
    set(editor.start.input, "17:30");
    set(editor.end.input, "18:15");
    const people = editor.whoList.querySelectorAll("input").length;
    editor.details.open = true;
    set(editor.frequency.input, "weekly");
    const summary = editor.repeatSummary.textContent;
    editor.saveButton.click();
    return { focused, people, summary };
  })()`);
  assert.equal(added.focused, true, "the editor opens with the title focused");
  assert.ok(added.people >= 1, "who lists this member");
  assert.match(added.summary, /^Every week on /, `the repeat in words: ${added.summary}`);
  await until(() => page(`document.querySelector("kin-event-editor dialog")?.open === false`));
  await idle();
  const today = await page(`document.querySelector("kin-app").ctx.navigation.currentCivilDate()`);
  await until(() => page(`(() => { const day = document.querySelector("kin-app").week.querySelector('.week-day[data-date="${today}"]'); return [...(day?.querySelectorAll(".week-event .cal-event-title") ?? [])].some((node) => node.textContent === ${JSON.stringify(title)}); })()`));
  const chip = await page(`(() => {
    const app = document.querySelector("kin-app");
    const chip = [...app.week.querySelectorAll(".week-event .cal-event")].find((node) => node.querySelector(".cal-event-title").textContent === ${JSON.stringify(title)});
    return { label: chip.getAttribute("aria-label"), who: chip.querySelector(".cal-event-who").textContent, swatch: chip.querySelector(".cal-swatch").className,
      toast: app.ctx.undo.toastAction.textContent, status: app.status.textContent };
  })()`);
  assert.ok(chip.label.startsWith(`${title}, `) && /Repeats/.test(chip.label), `a screen reader hears title, date, time, who: ${chip.label}`);
  assert.equal(chip.who, "You", "names beside the colour");
  assert.match(chip.swatch, /member-colour-\d+/);
  assert.equal(chip.toast, "Undo", "Undo follows adding");

  // ---- Month view and keyboard -------------------------------------------
  await page(`(() => { document.querySelector("kin-app").ctx.navigation.navigate("#week/month"); return true; })()`);
  await until(() => page(`Boolean(document.querySelector("kin-app").calendar.querySelector(".cal-month-cell"))`));
  await idle();
  await until(() => page(`(() => document.querySelector("kin-app").calendar.querySelector('.cal-month-cell[data-date="${today}"]')?.getAttribute("aria-label")?.includes(${JSON.stringify(title)}))()`));
  const month = await page(`(() => {
    const cal = document.querySelector("kin-app").calendar;
    const cell = cal.querySelector('.cal-month-cell[data-date="${today}"]');
    const roving = [...cal.querySelectorAll(".cal-month-cell")].filter((node) => node.tabIndex === 0).length;
    cell.focus();
    cell.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    const moved = Number(document.activeElement?.dataset?.date ?? 0);
    document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    return { grid: cal.querySelector("table").getAttribute("role"), current: cell.getAttribute("aria-current"), roving, moved, back: Number(document.activeElement?.dataset?.date ?? 0) };
  })()`);
  assert.equal(month.grid, "grid");
  assert.equal(month.current, "date", "today is marked");
  assert.equal(month.roving, 1, "one cell in the tab order");
  assert.ok(month.moved > today, "ArrowRight moves to the next day");
  assert.equal(month.back, today, "ArrowLeft moves back");
  const paged = await page(`(async () => {
    const cal = document.querySelector("kin-app").calendar;
    const before = cal.querySelector(".cal-period").textContent;
    document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "PageDown", bubbles: true }));
    await new Promise((resolve) => requestAnimationFrame(() => resolve()));
    const after = cal.querySelector(".cal-period").textContent;
    const focusedCell = document.activeElement?.classList.contains("cal-month-cell");
    cal.querySelector(".cal-today").click();
    return { before, after, focusedCell };
  })()`);
  assert.notEqual(paged.before, paged.after, "Page Down shows the next month");
  assert.equal(paged.focusedCell, true, "and keeps focus on a day");
  await idle();

  // ---- Cancel one occurrence, then Undo ---------------------------------
  await page(`(() => { document.querySelector("kin-app").ctx.navigation.navigate("#week/day"); return true; })()`);
  await until(() => page(`Boolean(document.querySelector("kin-app").calendar.querySelector(".cal-day"))`));
  await idle();
  await until(() => page(`[...document.querySelector("kin-app").calendar.querySelectorAll(".cal-day .cal-event-title")].some((node) => node.textContent === ${JSON.stringify(title)})`));
  await page(`(() => {
    const chip = [...document.querySelector("kin-app").calendar.querySelectorAll(".cal-day button.cal-event")].find((node) => node.querySelector(".cal-event-title").textContent === ${JSON.stringify(title)});
    chip.click();
    return true;
  })()`);
  await until(() => page(`document.querySelector("kin-event-editor dialog")?.open === true`));
  const editing = await page(`(() => {
    const editor = document.querySelector("kin-app").eventEditor;
    const scopeShown = !editor.scope.hidden;
    editor.cancelButton.click();
    const one = editor.cancelOne;
    const offered = !editor.cancelChoices.hidden && !one.hidden && document.activeElement === one;
    one.click();
    return { scopeShown, offered, heading: editor.heading.textContent };
  })()`);
  assert.deepEqual(editing, { scopeShown: true, offered: true, heading: "Change event" }, `editing a repeating event: ${JSON.stringify(editing)}`);
  await until(() => page(`document.querySelector("kin-event-editor dialog")?.open === false`));
  await idle();
  await until(() => page(`![...document.querySelector("kin-app").calendar.querySelectorAll(".cal-day .cal-event-title")].some((node) => node.textContent === ${JSON.stringify(title)})`));
  const cancelled = await page(`(() => { const app = document.querySelector("kin-app"); return { status: app.status.textContent, toast: app.ctx.undo.toastAction.textContent }; })()`);
  assert.match(cancelled.status, /^Cancelled .* on that day\./, cancelled.status);
  assert.equal(cancelled.toast, "Undo");
  await page(`(() => { document.querySelector("kin-app").ctx.undo.toastAction.click(); return true; })()`);
  await idle();
  await until(() => page(`[...document.querySelector("kin-app").calendar.querySelectorAll(".cal-day .cal-event-title")].some((node) => node.textContent === ${JSON.stringify(title)})`));
  const undone = await page(`(() => { const app = document.querySelector("kin-app"); return { status: app.status.textContent, toast: app.ctx.undo.toastAction.textContent }; })()`);
  assert.match(undone.status, /^Undone: cancel /, undone.status);
  assert.equal(undone.toast, "Redo");

  // Day row: the arrow keys move between days.
  const strip = await page(`(async () => {
    const cal = document.querySelector("kin-app").calendar;
    const first = cal.querySelector('.cal-strip-day[tabindex="0"]');
    first.focus();
    first.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    await new Promise((resolve) => requestAnimationFrame(() => resolve()));
    const focused = document.activeElement;
    return { pressed: focused?.getAttribute("aria-pressed"), date: Number(focused?.dataset.date ?? 0), label: focused?.getAttribute("aria-label") ?? "" };
  })()`);
  assert.equal(strip.pressed, "true", "the next day is chosen");
  assert.ok(strip.date > today && /events?|nothing planned/.test(strip.label), `day buttons say what is on: ${strip.label}`);
  await idle();

  // ---- My colour ------------------------------------------------------
  await page(`(() => { document.querySelector("kin-app").ctx.navigation.navigate("#household/appearance"); return true; })()`);
  await until(() => page(`Boolean(document.querySelector("kin-member-colour input[value='9']"))`));
  await page(`(() => { const input = document.querySelector("kin-member-colour input[value='9']"); input.click(); return true; })()`);
  await idle();
  await until(() => page(`document.querySelector("kin-member-colour .member-colour-feedback").textContent === "Your colour is Purple."`));
  await page(`(() => { document.querySelector("kin-app").ctx.navigation.navigate("#week"); return true; })()`);
  await idle();
  await until(() => page(`(() => { const chip = [...document.querySelector("kin-app").week.querySelectorAll(".week-event .cal-event")].find((node) => node.querySelector(".cal-event-title").textContent === ${JSON.stringify(title)}); return chip?.querySelector(".cal-swatch")?.classList.contains("member-colour-9"); })()`));

  // ---- Import a sample .ics, twice -------------------------------------
  const ics = [
    "BEGIN:VCALENDAR", "VERSION:2.0", `X-WR-CALNAME:School ${tag}`,
    "BEGIN:VEVENT", `UID:term-${tag}`, "DTSTART;VALUE=DATE:${DATE}", "SUMMARY:Term starts " + tag, "END:VEVENT",
    "BEGIN:VEVENT", `UID:club-${tag}`, "DTSTART;TZID=Europe/London:${DATE}T160000", "DTEND;TZID=Europe/London:${DATE}T170000", "RRULE:FREQ=WEEKLY;COUNT=4", "SUMMARY:Chess club " + tag, "END:VEVENT",
    "END:VCALENDAR", "",
  ].join("\r\n");
  const icsToday = ics.replaceAll("${DATE}", String(today));
  const importOnce = async () => {
    await page(`(() => { const app = document.querySelector("kin-app"); app.calendar.querySelector(".cal-import").click(); return true; })()`);
    await until(() => page(`document.querySelector("kin-calendar-import dialog")?.open === true`));
    return page(`(async () => {
      const dialog = document.querySelector("kin-app").calendarImport;
      const file = new File([${JSON.stringify(icsToday)}], "school.ics", { type: "text/calendar" });
      const preview = await dialog.read(file);
      return { preview, text: dialog.preview.textContent, button: dialog.importButton.textContent, disabled: dialog.importButton.disabled };
    })()`);
  };
  const first = await importOnce();
  assert.match(first.text, new RegExp(`^2 events from School ${tag}: 2 new\\.`), `the preview counts before saving: ${first.text}`);
  assert.deepEqual([first.button, first.disabled], ["Import 2 events", false]);
  await page(`(() => { document.querySelector("kin-app").calendarImport.importButton.click(); return true; })()`);
  await until(() => page(`document.querySelector("kin-calendar-import dialog")?.open === false`));
  await idle();
  await until(() => page(`[...document.querySelector("kin-app").week.querySelectorAll(".week-event .cal-event-title")].some((node) => node.textContent === "Chess club ${tag}")`));
  assert.match(await page(`document.querySelector("kin-app").status.textContent`), new RegExp(`^Imported 2 events from School ${tag}\\.`));
  const second = await importOnce();
  assert.match(second.text, /2 already in Kin\./, `importing again changes nothing: ${second.text}`);
  assert.equal(second.disabled, true, "nothing to import");
  await page(`(() => { document.querySelector("kin-app").calendarImport.cancelButton.click(); return true; })()`);
  const chessCount = await page(`[...document.querySelector("kin-app").week.querySelectorAll(".week-event .cal-event-title")].filter((node) => node.textContent === "Chess club ${tag}").length`);
  assert.equal(chessCount, 1, "no duplicates this week");

  // ---- A countdown on Today --------------------------------------------
  const trip = `Trip ${tag}`;
  const tripDate = await page(`(async () => {
    const app = document.querySelector("kin-app");
    const { addDays } = await import("/calendar/calendar-time.js");
    const date = addDays(${today}, 5);
    const outcome = await app.ctx.calendar.save({ draft: { title: ${JSON.stringify(trip)}, allDay: true, start: { date, minute: 0 }, end: { date, minute: 0 }, zone: "", attendees: [], place: "", notes: "", repeat: null, countdown: true }, placed: null, base: null, scope: "all" });
    if (!outcome.ok) throw new Error(JSON.stringify(outcome));
    app.ctx.navigation.navigate("#today");
    return date;
  })()`);
  assert.ok(tripDate > today);
  await idle();
  await until(() => page(`document.querySelector("kin-calendar-today .calendar-countdown")?.textContent === "5 days until ${trip}"`));
  const todayList = await page(`[...document.querySelectorAll("kin-calendar-today .cal-event-title")].map((node) => node.textContent)`);
  assert.ok(todayList.includes(title) && todayList.includes(`Chess club ${tag}`), `Today lists today's events: ${JSON.stringify(todayList)}`);

  // ---- 320px: no sideways scroll in any view ------------------------------
  await setViewport(client, { width: 320, height: 640, deviceScaleFactor: 2, mobile: true });
  try {
    for (const hash of ["#week", "#week/day", "#week/month", "#today"]) {
      await page(`(() => { document.querySelector("kin-app").ctx.navigation.navigate(${JSON.stringify(hash)}); return true; })()`);
      await idle();
      const view = await page(`({ scroll: document.documentElement.scrollWidth, inner: innerWidth })`);
      assert.ok(view.scroll <= view.inner, `${hash} at 320px: ${view.scroll} > ${view.inner}`);
    }
  } finally {
    await client.send("Emulation.clearDeviceMetricsOverride");
  }

  // ---- Easy mode: the Day view is a list ---------------------------------
  const easy = await page(`(async () => {
    const app = document.querySelector("kin-app");
    const toggle = () => app.personalSettings.querySelector(".easy-mode-setting input").click();
    const was = document.documentElement.dataset.kinEasy === "on";
    if (!was) toggle();
    for (let i = 0; i < 600 && document.documentElement.dataset.kinEasy !== "on"; i++) await new Promise((resolve) => requestAnimationFrame(() => resolve()));
    app.ctx.navigation.navigate("#week/day");
    app.ctx.calendar.focus = ${today};
    await app.ctx.calendar.refresh();
    const list = Boolean(app.calendar.querySelector(".cal-timed-list")) && !app.calendar.querySelector(".cal-timeline");
    const titles = [...app.calendar.querySelectorAll(".cal-timed-list .cal-event-title")].map((node) => node.textContent);
    if (!was) toggle();
    for (let i = 0; i < 600 && document.documentElement.dataset.kinEasy === "on"; i++) await new Promise((resolve) => requestAnimationFrame(() => resolve()));
    await app.ctx.calendar.refresh();
    return { list, titles, timelineAgain: Boolean(app.calendar.querySelector(".cal-timeline")) };
  })()`);
  assert.equal(easy.list, true, "easy mode shows the day as a list");
  assert.ok(easy.titles.includes(title), `with the day's events: ${JSON.stringify(easy.titles)}`);
  assert.equal(easy.timelineAgain, true, "and the timeline comes back without it");
  await page(`(() => { document.querySelector("kin-app").ctx.navigation.navigate("#today"); return true; })()`);
  await idle();
  return "PASS calendar: weekly event in Week and Month, cancel one with Undo, keyboard days and months, colour, .ics import twice, countdown on Today, 320px, easy mode (#660)";
}
