// The chore chart (#676, #677, #678) in the browser, through the real store
// and engine, with a child simulated beside this Adult: Today links to the
// chart; the child's card shows their routine and item in their colour with
// big tick boxes and the item's picture; an Adult sets a reward from the
// card and points from Routines; ticking earns the child's points (not the
// Adult's who ticked) and unticking takes them back; Join the chore chart
// shows only when adults are allowed, and the Adult can leave again.
export async function choreChartRegressions() {
  const app = document.querySelector("kin-app");
  const check = (condition, message, detail) => {
    if (!condition) throw new Error(`${message}${detail === undefined ? "" : ` ${JSON.stringify(detail)}`}`);
  };
  const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
  const until = async (test, message, detail) => {
    for (let index = 0; index < 900; index++) { if (test()) return; await frame(); }
    check(false, message, typeof detail === "function" ? detail() : detail);
  };
  const idle = () => until(() => !app.busy && !app.refreshing && !app.pendingRefresh && !app.wakePending, "the chore chart work settles");
  const me = app.ctx.detail.responsibilityContext().memberId;
  check(me, "this device knows its member");
  const child = "cd".repeat(16);
  const saved = { ids: app.activeMemberIds, kinds: app.activeMemberKinds, allowed: { ...app.ctx.chores.allowed } };
  const simulate = () => {
    app.activeMemberIds = [me, child];
    app.activeMemberKinds = new Map([[me, "adult"], [child, "limited"]]);
  };
  simulate();
  app.ctx.render.renderState();
  const tag = crypto.randomUUID().slice(0, 6);
  const routineText = `Feed the cat ${tag}`;
  const itemText = `Tidy room ${tag}`;
  await app.ctx.routines.saveRoutine({ type: "create-routine", text: routineText, cadence: "daily" });
  await idle();
  await app.ctx.items.handleAddItem({ detail: { text: itemText, classification: "need" } });
  await idle();
  const routineId = app.state.routines.find((routine) => routine.text === routineText).routineId;
  const itemId = app.state.items.find((item) => item.text === itemText).itemId;
  try {
    await app.ctx.append.appendCommand({ type: "change-responsibility", targetKind: "routine", id: routineId, memberId: child });
    await app.ctx.append.appendCommand({ type: "change-responsibility", targetKind: "item", id: itemId, memberId: child });
    await app.ctx.simple.setItemEmoji({ itemId, emoji: "🧸" });
    await idle();
    app.ctx.render.renderState();

    // Today links to the chart; Today stays marked.
    app.ctx.navigation.navigate("#today");
    const link = app.pages.get("today").querySelector(".today-chores-link");
    check(link?.getAttribute("href") === "#chores" && link.textContent === "Chore chart" && link.dataset.featureRoute === "chores", "Today links to the chore chart");
    link.click();
    simulate();
    await until(() => !app.pages.get("chores").hidden, "the chore chart shows");
    check(app.navLinks.get("today").getAttribute("aria-current") === "page", "Today stays marked in the navigation");
    const chart = app.choreChart;
    const card = () => chart.querySelector(`.chore-card[data-member-id="${child}"]`);
    const row = (key) => card()?.querySelector(`.chore-row[data-key="${key}"]`);
    const routineKey = () => [...(card()?.querySelectorAll(".chore-row") ?? [])].find((node) => node.dataset.key.startsWith(`routine:${routineId}:`))?.dataset.key;
    await until(() => routineKey() && row(`item:${itemId}`), "the child's card lists their routine and item for today", () => chart.textContent);
    check(card().style.getPropertyValue("--chore-colour").trim().startsWith("#"), "the card has the child's colour");
    check(card().querySelector(".chore-card-name").textContent === "Household member 1", "and their name beside it", card().querySelector(".chore-card-name").textContent);
    check(!chart.querySelector(`.chore-card[data-member-id="${me}"]`), "adults aren't on the chart by default");
    const box = (key) => row(key).querySelector("input.chore-box");
    check(box(`item:${itemId}`).getBoundingClientRect().width >= 40, "the tick boxes are big");
    check(row(`item:${itemId}`).querySelector(".chore-picture").textContent === "🧸", "the item's picture shows");
    check(card().querySelector(".chore-points").textContent === "0 points this week", "no points yet", card().querySelector(".chore-points").textContent);

    // A reward from the card.
    const toggle = card().querySelector(".chore-reward-toggle");
    check(toggle?.textContent === "Set a reward", "an Adult can set the child's reward");
    toggle.click();
    await until(() => card().querySelector(".chore-reward-form"), "the reward form opens");
    check(document.activeElement === card().querySelector('input[type="number"]'), "focus moves to the goal");
    card().querySelector('input[type="number"]').value = "5";
    card().querySelector('input[type="text"]').value = "Ice cream";
    card().querySelector(".chore-reward-form").requestSubmit();
    await idle();
    await until(() => card()?.querySelector(".chore-points")?.textContent === "0 of 5 for Ice cream", "the reward shows", () => card()?.textContent);
    check(card().querySelector("progress.chore-progress")?.max === 5, "with its progress");

    // Ticking earns the child's points, even though an Adult ticked it.
    box(routineKey()).click();
    await idle();
    await until(() => card()?.querySelector(".chore-points")?.textContent === "1 of 5 for Ice cream", "ticking earns a point for the child", () => card()?.textContent);
    check(box(routineKey()).checked && row(routineKey()).classList.contains("is-done"), "the job shows done");
    box(`item:${itemId}`).click();
    await idle();
    await until(() => card()?.querySelector(".chore-points")?.textContent === "2 of 5 for Ice cream", "the item earns one too");
    await until(() => card()?.querySelector(".chore-all-done"), "and today's jobs are all done");

    // Points per routine, from Routines.
    app.ctx.navigation.navigate("#routines");
    simulate();
    const points = () => app.routines.querySelector(`select[data-action="set-chore-points"][data-routine-id="${routineId}"]`);
    await until(() => points(), "Routines offers the routine's chore chart points");
    check(points().value === "1" && points().getAttribute("aria-label") === `Chore chart points for ${routineText}`, "1 point by default");
    points().value = "3";
    points().dispatchEvent(new Event("change", { bubbles: true }));
    await idle();
    await until(() => points()?.value === "3", "the routine is worth 3 now");
    app.ctx.navigation.navigate("#chores");
    simulate();
    await until(() => card()?.querySelector(".chore-points")?.textContent === "4 of 5 for Ice cream", "this week's points follow the routine's value", () => card()?.textContent);

    // Unticking takes the points back.
    box(routineKey()).click();
    await idle();
    await until(() => card()?.querySelector(".chore-points")?.textContent === "1 of 5 for Ice cream", "unticking takes the points back", () => card()?.textContent);

    // Adults join only when allowed, and can leave.
    const join = () => app.choreJoin;
    if (!app.ctx.chores.adultsAllowed) {
      check(join().hidden, "no Join while an admin hasn't allowed adults");
      app.ctx.chores.receiveSetting({ adults: true, revision: app.ctx.chores.allowed.revision + 1, admin: true });
    }
    await until(() => !join().hidden, "Join the chore chart shows once adults are allowed");
    const button = join().querySelector(".chore-join-button");
    check(button.textContent === "Join the chore chart", "Join is offered");
    button.click();
    await idle();
    await until(() => chart.querySelector(`.chore-card[data-member-id="${me}"]`), "the Adult joins the chart", () => chart.textContent);
    check(chart.querySelector(`.chore-card[data-member-id="${me}"] .chore-card-name`).textContent === "You", "as You");
    check(button.textContent === "Leave the chore chart", "and can leave");
    button.click();
    await idle();
    await until(() => !chart.querySelector(`.chore-card[data-member-id="${me}"]`), "leaving takes the Adult off the chart");
    check(document.documentElement.scrollWidth <= innerWidth, "nothing scrolls sideways");
  } finally {
    app.ctx.chores.allowed = saved.allowed;
    await app.ctx.items.handleItemAction("archive", itemId);
    await idle();
    await app.ctx.routines.saveRoutine({ type: "archive-routine", routineId });
    await idle();
    app.activeMemberIds = saved.ids;
    app.activeMemberKinds = saved.kinds;
    app.ctx.render.renderState();
    app.ctx.undo.clear();
    app.ctx.navigation.navigate("#today");
  }
  return "PASS chore chart: from Today, the child's card in their colour with pictures and big tick boxes, a reward, points to the chore's owner and back on untick, points per routine, adults join only when allowed and can leave (#676)";
}
