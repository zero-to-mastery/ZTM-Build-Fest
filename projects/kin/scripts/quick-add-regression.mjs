export async function quickAddRegressions() {
  const app = document.querySelector("kin-app");
  const quick = app.quickAdd;
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const idle = async () => {
    for (let index = 0; (app.busy || app.refreshing || app.pendingRefresh || app.wakePending) && index < 400; index++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    check(!app.busy && !app.refreshing && !app.pendingRefresh && !app.wakePending, "quick-add returns idle");
  };
  const count = (text) => app.state.items.filter((item) => item.text === text).length;
  const add = async (text) => {
    quick.trigger.click();
    quick.input.value = text;
    quick.input.dispatchEvent(new Event("input", { bubbles: true }));
    quick.form.requestSubmit();
    await idle();
  };

  app.ctx.navigation.navigate("#today");
  quick.trigger.focus();
  quick.trigger.click();
  check(quick.dialog.open && document.activeElement === quick.input, "opening focuses the labeled task title");
  quick.input.value = "";
  quick.form.requestSubmit();
  check(quick.dialog.open && quick.error.textContent === "Enter a task title." && document.activeElement === quick.input,
    "empty quick-add stays open with accessible feedback");
  quick.dialog.close();
  check(document.activeElement === quick.trigger, "closing restores focus to the trigger");

  const escape = new Event("cancel", { cancelable: true });
  quick.trigger.click();
  quick.dialog.dispatchEvent(escape);
  if (!escape.defaultPrevented) quick.dialog.close();
  check(!quick.dialog.open && document.activeElement === quick.trigger, "Escape closes without creating a task");

  const imeText = `IME task ${crypto.randomUUID().slice(0, 6)}`;
  quick.trigger.click();
  quick.input.value = imeText;
  quick.input.dispatchEvent(new CompositionEvent("compositionstart"));
  quick.form.requestSubmit();
  check(count(imeText) === 0 && quick.dialog.open, "IME composition does not submit");
  quick.input.dispatchEvent(new CompositionEvent("compositionend"));
  quick.form.requestSubmit();
  quick.form.requestSubmit();
  quick.addButton.click();
  await idle();
  const todayItem = app.state.items.find((item) => item.text === imeText);
  check(count(imeText) === 1 && todayItem?.planningDate === app.ctx.navigation.currentCivilDate() && !quick.dialog.open,
    "rapid mixed submission creates exactly one durable task visible on Today");

  app.ctx.navigation.navigate("#lists/shopping");
  const shoppingText = `Quick shopping ${crypto.randomUUID().slice(0, 6)}`;
  await add(shoppingText);
  check(count(shoppingText) === 1 && app.state.items.find((item) => item.text === shoppingText)?.classification === "shopping",
    "quick-add uses the current task-list destination and canonical defaults");

  app.ctx.navigation.navigate("#lists/todo");
  const retryText = `Retry quick add ${crypto.randomUUID().slice(0, 6)}`;
  const originalAppend = app.ctx.append.appendCommand;
  let attempts = 0;
  app.ctx.append.appendCommand = async function (command) {
    if (command.type === "add" && command.text === retryText && attempts++ === 0) throw new Error("forced local failure");
    return originalAppend.call(this, command);
  };
  await add(retryText);
  const failureState = { open: quick.dialog.open, value: quick.input.value, count: count(retryText), pending: quick.pending, error: quick.error.textContent };
  check(failureState.open && failureState.value === retryText && failureState.count === 0 && !failureState.pending,
    `a local save failure preserves the title and permits retry (${JSON.stringify(failureState)})`);
  quick.form.requestSubmit();
  await idle();
  app.ctx.append.appendCommand = originalAppend;
  check(count(retryText) === 1 && !quick.dialog.open, "failed submission retries safely exactly once");

  // A Today capture is multi-command: the Item may be durable before its
  // planning date. Editing the title must expose the established recovery
  // choice instead of leaving Quick Add's local pending guard stuck.
  app.ctx.navigation.navigate("#today");
  const partialA = `Partial task A ${crypto.randomUUID().slice(0, 6)}`;
  const nextB = `Next task B ${crypto.randomUUID().slice(0, 6)}`;
  let dateFailures = 1;
  app.ctx.append.appendCommand = async function (command) {
    if (command.type === "set-item-planning-date" && dateFailures-- > 0) throw new Error("forced date failure");
    return originalAppend.call(this, command);
  };
  await add(partialA);
  const partialItem = app.state.items.find((item) => item.text === partialA);
  check(count(partialA) === 1 && partialItem?.planningDate == null && quick.dialog.open &&
    quick.input.value === partialA && quick.error.textContent.includes("Couldn't set the date") && app.pendingCapture?.draft.id === partialItem.itemId,
  "a failed secondary command reports one durable partial task and preserves its draft");
  quick.input.value = nextB;
  quick.input.dispatchEvent(new Event("input", { bubbles: true }));
  quick.form.requestSubmit();
  quick.form.requestSubmit();
  const finishPrevious = [...quick.error.querySelectorAll("button")].find((button) => button.textContent === "Finish previous task");
  check(quick.recoveryVisible && finishPrevious && document.activeElement === finishPrevious && count(partialA) === 1 && count(nextB) === 0,
    "an edited draft exposes an announced, keyboard-focused recovery choice without duplication");
  finishPrevious.click();
  finishPrevious.click();
  await idle();
  check(count(partialA) === 1 && app.state.items.find((item) => item.itemId === partialItem.itemId)?.planningDate === app.ctx.navigation.currentCivilDate() &&
    app.pendingCapture == null && quick.input.value === nextB && quick.error.textContent.includes("Previous task finished"),
  "Finish previous task retries only the missing date and retains the new draft");
  quick.form.requestSubmit();
  await idle();
  check(count(partialA) === 1 && count(nextB) === 1 && !quick.dialog.open,
    "the retained new draft submits exactly once after previous recovery");

  const partialC = `Partial task C ${crypto.randomUUID().slice(0, 6)}`;
  const nextD = `Next task D ${crypto.randomUUID().slice(0, 6)}`;
  dateFailures = 1;
  await add(partialC);
  const partialCItem = app.state.items.find((item) => item.text === partialC);
  check(count(partialC) === 1 && partialCItem?.planningDate == null && app.pendingCapture?.draft.id === partialCItem.itemId,
    "a second partial task remains recoverable");
  quick.cancelButton.click();
  quick.trigger.click();
  quick.input.value = nextD;
  quick.input.dispatchEvent(new Event("input", { bubbles: true }));
  quick.form.requestSubmit();
  const startNew = [...quick.error.querySelectorAll("button")].find((button) => button.textContent === "Start new task");
  check(startNew && quick.recoveryVisible && count(nextD) === 0,
    "closing and reopening still resolves the app-owned partial capture before a new task");
  startNew.click();
  await idle();
  app.ctx.append.appendCommand = originalAppend;
  check(count(partialC) === 1 && app.state.items.find((item) => item.itemId === partialCItem.itemId)?.planningDate == null &&
    count(nextD) === 1 && app.state.items.find((item) => item.text === nextD)?.planningDate === app.ctx.navigation.currentCivilDate() && !quick.dialog.open,
  "Start new task explicitly retains the prior partial record and creates the new task once");

  return "PASS universal quick-add focus, validation, IME, duplicate guard, routing, durability, retry, and partial-capture recovery";
}
