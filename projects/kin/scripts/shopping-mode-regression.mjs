// Shopping mode (#403, #404, #408) in the browser, through the real store and
// engine: Start shopping opens a full-screen list of what to buy with large
// native checkboxes; ticking completes an item (Undo applies) and moves it to
// "In the basket"; unticking reopens it; Escape or Done shopping closes and
// returns focus. Checked at the current viewport; the caller runs it at 320px.
export async function shoppingModeRegressions() {
  const app = document.querySelector("kin-app");
  const check = (condition, message, detail) => {
    if (!condition) throw new Error(`${message}${detail === undefined ? "" : ` ${JSON.stringify(detail)}`}`);
  };
  const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
  const idle = async () => {
    for (let index = 0; (app.busy || app.refreshing || app.pendingRefresh || app.wakePending) && index < 600; index++) await frame();
    check(!app.busy, "shopping work returns idle");
  };
  const tag = crypto.randomUUID().slice(0, 6);
  const names = [`Milk ${tag}`, `Bread ${tag}`, `Apples ${tag}`];
  for (const text of names) {
    await app.ctx.items.handleAddItem({ detail: { text, classification: "shopping" } });
    await idle();
  }
  app.ctx.navigation.navigate("#lists/shopping");
  await frame();
  const start = app.shopping.querySelector(".start-shopping");
  check(start?.textContent === "Start shopping", "Shopping has Start shopping");
  start.focus();
  start.click();
  await frame();
  const mode = app.shoppingMode;
  const dialog = mode.querySelector("dialog");
  check(dialog.open && dialog.getAttribute("aria-labelledby") === "shopping-mode-title", "Start shopping opens a labelled full-screen dialog");
  const row = (text) => [...mode.querySelectorAll(".shopping-mode-item")].find((item) => item.textContent === text);
  const box = (text) => row(text)?.querySelector("input");
  for (const text of names) check(box(text) && !box(text).checked, `${text} is listed to buy`);
  const target = box(names[0]).getBoundingClientRect();
  const label = row(names[0]).querySelector("label").getBoundingClientRect();
  check(label.height >= 56 && target.width >= 28, "rows are at least 56px tall with large boxes", { label: label.height, box: target.width });
  check(document.activeElement?.tagName === "INPUT" && mode.contains(document.activeElement), "focus starts on the first item");
  check(document.documentElement.scrollWidth <= innerWidth, "nothing scrolls sideways");

  // Tick one: completed, in the basket, Undo offered.
  box(names[1]).click();
  await idle();
  await frame();
  const bread = () => app.state.items.find((item) => item.text === names[1]);
  check(bread().status === "completed", "ticking completes the item");
  const basket = mode.querySelector(".shopping-mode-basket");
  check(!basket.hidden && basket.querySelector("summary").textContent === "In the basket: 1" && box(names[1])?.checked, "it moves to In the basket");
  check(mode.querySelector(".shopping-mode-count").textContent.startsWith(`${mode.querySelectorAll(".shopping-mode-list[aria-label='To buy'] input").length} thing`), "the count says how many are left");
  check(!app.ctx.undo.toast.hidden && app.ctx.undo.toastAction.textContent === "Undo", "Undo is offered");

  // Untick it in the basket: reopened, back on the list.
  basket.open = true;
  box(names[1]).click();
  await idle();
  await frame();
  check(bread().status === "active" && !box(names[1]).checked && basket.hidden, "unticking reopens it");

  // Escape closes and focus returns to Start shopping.
  dialog.dispatchEvent(new Event("cancel", { cancelable: true }));
  await frame();
  check(!dialog.open && document.activeElement?.classList.contains("start-shopping"), "Escape closes shopping mode and returns focus");

  // Tidy up: the items stay ordinary Shopping items.
  for (const text of names) {
    const item = app.state.items.find((record) => record.text === text);
    await app.ctx.items.handleItemAction("archive", item.itemId);
    await idle();
  }
  app.ctx.undo.clear();
  app.ctx.navigation.navigate("#today");
  return "PASS shopping mode: start, large rows, tick to basket with Undo, untick to reopen, Escape returns focus (#403)";
}
