// Undo and redo (#315) and Delete routine (#314), inside the browser against
// real DOM, storage and Rust/WASM replay: the toast after a change, Undo and
// then Redo on it, Ctrl/Cmd+Z and Shift+Ctrl/Cmd+Z outside text fields only,
// refusal when the thing changed since, archive undone by creating it again,
// and a deleted routine brought back with its completion.
export async function undoRegressions() {
  const app = document.querySelector("kin-app");
  const check = (condition, message, detail) => {
    if (!condition) throw new Error(`${message}${detail === undefined ? "" : ` ${JSON.stringify(detail)}`}`);
  };
  const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
  const idle = async () => {
    for (let index = 0; (app.busy || app.refreshing || app.pendingRefresh || app.wakePending || app.ctx.undo.running) && index < 600; index++) await frame();
    check(!app.busy && !app.ctx.undo.running, "undo work returns idle");
  };
  // Each change gets its own millisecond, so "changed since" is never a tie.
  const originalNow = Date.now;
  let now = originalNow.call(Date);
  Date.now = () => (now += 5);
  const toast = () => app.ctx.undo.toast;
  const toastState = () => ({
    shown: !toast().hidden,
    text: app.ctx.undo.toastText.textContent,
    action: app.ctx.undo.toastAction.textContent,
    statusHidden: app.status.classList.contains("status-in-toast"),
  });
  const item = (text) => app.state.items.filter((record) => record.text === text);
  const key = (init, target = document.activeElement ?? document.body) => {
    const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, composed: true, ...init });
    target.dispatchEvent(event);
    return event.defaultPrevented;
  };
  const heading = () => app.main.querySelector(".app-view:not([hidden]) h1");
  try {
    // 1. Adding offers Undo; the toast repeats the confirmation, which the
    // status line still announces.
    const text = `Undo ${crypto.randomUUID()}`;
    app.compose.input.value = text;
    app.compose.classification.value = "need";
    app.compose.form.requestSubmit();
    await idle();
    const added = item(text)[0];
    check(added?.status === "active", "the item was added");
    let seen = toastState();
    check(seen.shown && seen.action === "Undo" && seen.text === app.status.textContent && seen.statusHidden,
      "adding shows the toast with Undo, repeating the status line", seen);

    // 2. Complete, then Undo and Redo on the toast.
    await app.ctx.items.handleItemAction("complete", added.itemId);
    await idle();
    check(item(text)[0].status === "completed" && toastState().action === "Undo", "completing offers Undo");
    app.ctx.undo.toastAction.click();
    await idle();
    seen = toastState();
    check(item(text)[0].status === "active" && seen.shown && seen.action === "Redo" && /^Undone: mark “.+” done\./.test(seen.text),
      "Undo reopens it and offers Redo", seen);
    app.ctx.undo.toastAction.click();
    await idle();
    seen = toastState();
    check(item(text)[0].status === "completed" && seen.action === "Undo" && /^Redone: mark “.+” done\./.test(seen.text),
      "Redo completes it again and offers Undo", seen);

    // 3. Keyboard: Ctrl+Z and Ctrl+Shift+Z outside text fields; a text field
    // keeps its own undo.
    const mac = app.macShortcuts;
    const mod = mac ? { metaKey: true } : { ctrlKey: true };
    heading().focus();
    check(key({ key: "z", code: "KeyZ", ...mod }), "Ctrl/Cmd+Z is taken outside text fields");
    await idle();
    check(item(text)[0].status === "active", "Ctrl/Cmd+Z undid the completion");
    heading().focus();
    check(key({ key: "Z", code: "KeyZ", shiftKey: true, ...mod }), "Shift+Ctrl/Cmd+Z is taken");
    await idle();
    check(item(text)[0].status === "completed", "Shift+Ctrl/Cmd+Z redid it");
    app.compose.input.focus();
    check(!key({ key: "z", code: "KeyZ", ...mod }), "a text field keeps Ctrl/Cmd+Z");
    await frame();
    check(item(text)[0].status === "completed" && !app.busy, "nothing was undone from a text field");

    // 4. Changed since (here by a change Undo didn't record): refused, left
    // as it is.
    await app.ctx.append.appendCommand({ type: "set-item-planning-date", itemId: added.itemId, planningDate: 20300101 });
    app.ctx.render.renderState();
    heading().focus();
    key({ key: "z", code: "KeyZ", ...mod });
    await idle();
    check(item(text)[0].status === "completed" && /^Couldn't undo that .*changed since/.test(app.status.textContent),
      "undo is refused when the item changed since", { status: app.status.textContent });

    // 5. Archive is undone by creating it again; the original stays archived.
    await app.ctx.items.handleItemAction("reopen", added.itemId);
    await idle();
    await app.ctx.items.handleItemAction("archive", added.itemId);
    await idle();
    check(toastState().action === "Undo", "archiving offers Undo");
    app.ctx.undo.toastAction.click();
    await idle();
    const copies = item(text);
    const copy = copies.find((record) => record.itemId !== added.itemId);
    check(copies.find((record) => record.itemId === added.itemId)?.status === "archived" && copy?.status === "active" &&
      copy.planningDate === 20300101 && copy.classification === "need",
      "Undo brings an archived item back with its list and date; the original stays in history", copies);
    app.ctx.undo.toastAction.click();
    await idle();
    check(item(text).every((record) => record.status === "archived"), "Redo archives it again");

    // 6. Dismiss hides the toast; nothing else changes.
    app.ctx.undo.toast.querySelector(".undo-toast-dismiss").click();
    check(toast().hidden && !app.status.classList.contains("status-in-toast"), "Dismiss hides the toast");

    // 7. Delete routine (#314): no confirmation, gone from Routines and
    // Today, history kept; Undo brings it back with today's completion.
    const title = `Routine ${crypto.randomUUID()}`;
    await app.ctx.routines.saveRoutine({ type: "create-routine", text: title, cadence: "daily" });
    await idle();
    const routine = app.state.routines.find((record) => record.text === title);
    check(routine?.occurrenceStatus === "open", "the routine is open today", routine);
    await app.ctx.routines.saveRoutine({ type: "complete-routine-occurrence", routineId: routine.routineId, occurrenceKey: routine.occurrenceKey });
    await idle();
    app.ctx.navigation.navigate("#routines");
    await frame();
    const button = app.routines.querySelector(`[data-routine-id="${routine.routineId}"] [data-action="archive-routine"]`);
    check(button?.textContent === "Delete routine", "the row's action is Delete routine", { label: button?.textContent });
    button.click();
    await idle();
    seen = toastState();
    check(app.state.routines.find((record) => record.routineId === routine.routineId)?.status === "archived" &&
      !app.routines.querySelector(`li[data-routine-id="${routine.routineId}"]`) &&
      !app.today.querySelector(`[data-routine-id="${routine.routineId}"]`) &&
      seen.shown && seen.action === "Undo" && seen.text.startsWith("Routine deleted. Past completions are kept."),
      "Delete routine removes it from Routines and Today and offers Undo", seen);
    app.ctx.undo.toastAction.click();
    await idle();
    const back = app.state.routines.filter((record) => record.text === title && record.status === "active");
    check(back.length === 1 && back[0].routineId !== routine.routineId && back[0].cadence === "daily" && back[0].occurrenceStatus === "completed" &&
      app.routines.querySelector(`li[data-routine-id="${back[0].routineId}"]`),
      "Undo brings the routine back with its schedule and today's completion", back);
    app.ctx.undo.toastAction.click();
    await idle();
    check(app.state.routines.every((record) => record.text !== title || record.status === "archived"), "Redo deletes it again");

    // 8. Nothing left to redo after a new change; an empty stack says so.
    app.ctx.undo.history.clear();
    heading()?.focus();
    key({ key: "z", code: "KeyZ", ...mod });
    await idle();
    check(app.status.textContent === "Nothing to undo.", "an empty history says so", { status: app.status.textContent });
  } finally {
    Date.now = originalNow;
    app.ctx.undo.clear();
    app.ctx.navigation.navigate("#today");
  }
  return "PASS undo and redo: toast with Undo then Redo, Ctrl/Cmd+Z outside text fields, refusal when changed since, archive and Delete routine undone by creating again (#314, #315)";
}
