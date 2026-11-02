// This week (#416, #421, #425) in the browser, through the real store and
// engine: Today links to This week; seven days, today first; an item planned
// for tomorrow shows on Tomorrow and completes from there (Undo offered);
// Move to… moves it to another day; a daily routine shows on today with a
// checkbox and later days without one. Nothing past today is overdue here.
export async function weekRegressions() {
  const app = document.querySelector("kin-app");
  const check = (condition, message, detail) => {
    if (!condition) throw new Error(`${message}${detail === undefined ? "" : ` ${JSON.stringify(detail)}`}`);
  };
  const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
  const until = async (test, message) => {
    for (let index = 0; index < 900; index++) { if (test()) return; await frame(); }
    check(false, message);
  };
  const idle = () => until(() => !app.busy && !app.refreshing && !app.pendingRefresh && !app.wakePending, "the week work settles");
  const today = app.ctx.navigation.currentCivilDate();
  const days = await app.store.week(today);
  const tomorrow = days[1].date;
  const third = days[2].date;
  const tag = crypto.randomUUID().slice(0, 6);
  const text = `Week item ${tag}`;
  await app.ctx.items.handleAddItem({ detail: { text, classification: "need", planningDate: tomorrow } });
  await idle();
  const routineText = `Week routine ${tag}`;
  await app.ctx.routines.saveRoutine({ type: "create-routine", text: routineText, cadence: "daily" });
  await idle();
  const itemId = app.state.items.find((item) => item.text === text).itemId;
  const routineId = app.state.routines.find((routine) => routine.text === routineText).routineId;

  const link = app.pages.get("today").querySelector(".today-week-link");
  check(link?.getAttribute("href") === "#week" && link.textContent === "This week", "Today links to This week");
  link.click();
  const view = app.week;
  await until(() => !app.pages.get("week").hidden && view.querySelectorAll(".week-day").length === 7, "This week shows seven days");
  check(app.navLinks.get("today").getAttribute("aria-current") === "page", "Today stays marked in the navigation");
  const headings = [...view.querySelectorAll(".week-day h2")].map((heading) => heading.textContent);
  check(headings[0].startsWith("Today") && headings[1].startsWith("Tomorrow"), "today first, then tomorrow", headings);
  const day = (date) => view.querySelector(`.week-day[data-date="${date}"]`);
  await until(() => day(tomorrow)?.querySelector(`[data-item-id="${itemId}"]`), "the planned item is on Tomorrow");
  check(!day(today).querySelector(`[data-item-id="${itemId}"]`), "and not on today");
  const routineToday = day(today).querySelector(`[data-routine-id="${routineId}"]`);
  check(routineToday?.querySelector("input[type=checkbox]"), "a daily routine can be completed today", day(today).textContent);
  const routineLater = day(third).querySelector(`[data-routine-id="${routineId}"]`);
  check(routineLater && !routineLater.querySelector("input"), "later occurrences show without a checkbox");

  // Complete from the week, with Undo.
  day(tomorrow).querySelector(`[data-item-id="${itemId}"] input[type=checkbox]`).click();
  await idle();
  check(app.state.items.find((item) => item.itemId === itemId).status === "completed" && app.ctx.undo.toastAction.textContent === "Undo", "completing from the week works, with Undo");
  app.ctx.undo.toastAction.click();
  await idle();
  check(app.state.items.find((item) => item.itemId === itemId).status === "active", "Undo reopens it");

  // Move to another day.
  await until(() => day(tomorrow)?.querySelector(`[data-item-id="${itemId}"] .week-move`), "the row is redrawn");
  const move = day(tomorrow).querySelector(`[data-item-id="${itemId}"] .week-move`);
  check(move.getAttribute("aria-label") === `Move ${text} to another day` && [...move.options].some((option) => option.value === String(third)), "Move to… lists the other days");
  move.value = String(third);
  move.dispatchEvent(new Event("change", { bubbles: true }));
  await idle();
  check(app.state.items.find((item) => item.itemId === itemId).planningDate === third, "Move to… sets the planned date");
  await until(() => day(third)?.querySelector(`[data-item-id="${itemId}"]`) && !day(tomorrow)?.querySelector(`[data-item-id="${itemId}"]`), "the item moves to that day");
  check(document.documentElement.scrollWidth <= innerWidth, "nothing scrolls sideways");

  // Tidy up.
  await app.ctx.items.handleItemAction("archive", itemId);
  await idle();
  await app.ctx.routines.saveRoutine({ type: "archive-routine", routineId });
  await idle();
  app.ctx.undo.clear();
  app.ctx.navigation.navigate("#today");
  return "PASS this week: seven days from Today, planned items and routines by day, complete with Undo, Move to… (#416)";
}
