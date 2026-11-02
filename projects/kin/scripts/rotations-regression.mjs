// Taking turns on routines (#428, #433, #437) in the browser, through the
// real store and engine, with a second household member simulated: start
// taking turns from Routines, see whose turn it is there and on Today, the
// turn passes when the routine is done (and back on Undo), Skip to next, and
// Stop taking turns hands the routine back to ordinary responsibility.
export async function rotationsRegressions() {
  const app = document.querySelector("kin-app");
  const check = (condition, message, detail) => {
    if (!condition) throw new Error(`${message}${detail === undefined ? "" : ` ${JSON.stringify(detail)}`}`);
  };
  const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
  const until = async (test, message) => {
    for (let index = 0; index < 900; index++) { if (test()) return; await frame(); }
    check(false, message);
  };
  const idle = () => until(() => !app.busy && !app.refreshing && !app.pendingRefresh && !app.wakePending, "the turn work settles");
  const me = app.ctx.detail.responsibilityContext().memberId;
  check(me, "this device knows its member");
  const other = "ab".repeat(16);
  const savedActive = app.activeMemberIds;
  app.activeMemberIds = [me, other];
  app.ctx.render.renderState();
  const tag = crypto.randomUUID().slice(0, 6);
  const text = `Bins out ${tag}`;
  await app.ctx.routines.saveRoutine({ type: "create-routine", text, cadence: "daily" });
  await idle();
  const routineId = app.state.routines.find((routine) => routine.text === text).routineId;
  try {
    app.ctx.navigation.navigate("#routines");
    const row = () => app.routines.querySelector(`.routine-row[data-routine-id="${routineId}"]`);
    const turns = () => row()?.querySelector("kin-rotation");
    await until(() => turns()?.querySelector('[data-key="start"]'), "Routines offers Take turns…");
    const start = turns().querySelector('[data-key="start"]');
    check(start.textContent === "Take turns…" && start.getAttribute("aria-label") === `Take turns on ${text}`, "the button is named for the routine");
    start.click();
    await until(() => turns().querySelector("fieldset.rotation-editor"), "the editor opens");
    check(document.activeElement === turns().querySelector(`input[data-key="pick:${me}"]`), "focus moves to the first person");
    const save = () => turns().querySelector('[data-key="save"]');
    check(save().disabled, "one person can't take turns alone");
    turns().querySelector(`input[data-key="pick:${me}"]`).click();
    turns().querySelector(`input[data-key="pick:${other}"]`).click();
    check([...turns().querySelectorAll(".rotation-draft li span")].map((node) => node.textContent).join() === "You,Household member 1", "the order follows the ticks");
    check(!save().disabled && save().textContent === "Start taking turns", "two people can start");
    save().click();
    await idle();
    await until(() => app.rotations?.get(routineId)?.current === me, "it's my turn first");
    await until(() => turns()?.querySelector(".rotation-turn")?.textContent === "Your turn · Household member 1 next", "Routines shows whose turn it is", turns()?.textContent);
    check(turns().querySelector(".rotation-order").textContent === "Taking turns: You → Household member 1", "and the order");
    check(!row().querySelector("kin-responsibility"), "the owner buttons give way to the turn");

    // Today shows it too.
    app.ctx.navigation.navigate("#today");
    const todayRow = () => app.pages.get("today").querySelector(`.routine-row[data-routine-id="${routineId}"]`);
    await until(() => todayRow()?.querySelector(".item-meta")?.textContent.includes("Your turn"), "Today shows Your turn");

    // Done passes the turn on; Undo brings it back.
    todayRow().querySelector('[data-action="complete-routine-occurrence"]').click();
    await idle();
    await until(() => app.rotations?.get(routineId)?.current === other, "the turn passes when it's done");
    check(app.ctx.undo.toastAction.textContent === "Undo", "Undo is offered");
    app.ctx.undo.toastAction.click();
    await idle();
    await until(() => app.rotations?.get(routineId)?.current === me, "Undo gives the turn back");

    // Skip to next, from Routines.
    app.ctx.navigation.navigate("#routines");
    await until(() => turns()?.querySelector('[data-key="skip"]'), "Skip to next is offered");
    const skip = turns().querySelector('[data-key="skip"]');
    check(skip.getAttribute("aria-label") === `Skip to next: give ${text} to Household member 1`, "Skip says who gets it", skip.getAttribute("aria-label"));
    skip.focus();
    skip.click();
    await idle();
    await until(() => turns()?.querySelector(".rotation-turn")?.textContent === "Household member 1's turn · You next", "Skip moves the turn");
    check(document.activeElement?.dataset.key === "skip" && turns().contains(document.activeElement), "focus stays on Skip to next");
    const owner = app.state.responsibilities.find((entry) => entry.targetKind === "routine" && entry.targetId === routineId)?.memberId;
    check(owner === other, "the routine's owner follows the turn", owner);

    // Stop taking turns.
    turns().querySelector('[data-key="stop"]').click();
    await idle();
    await until(() => !app.rotations?.has(routineId) && row()?.querySelector("kin-responsibility"), "stopping hands back ordinary responsibility");
    check(turns().querySelector('[data-key="start"]'), "and Take turns… is offered again");
    check(document.documentElement.scrollWidth <= innerWidth, "nothing scrolls sideways");
  } finally {
    await app.ctx.routines.saveRoutine({ type: "archive-routine", routineId });
    await idle();
    app.activeMemberIds = savedActive;
    app.ctx.render.renderState();
    app.ctx.undo.clear();
    app.ctx.navigation.navigate("#today");
  }
  return "PASS taking turns: start from Routines, whose turn on Routines and Today, passes when done and back on Undo, Skip to next, Stop (#428)";
}
