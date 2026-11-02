export async function shoppingRegressions() {
  const app = document.querySelector("kin-app");
  const check = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const idle = async () => {
    for (
      let i = 0;
      (app.busy || app.refreshing || app.pendingRefresh || app.wakePending) && i < 300;
      i++
    )
      await new Promise((resolve) => setTimeout(resolve, 10));
    check(!app.busy && !app.refreshing && !app.pendingRefresh && !app.wakePending, "Shopping work returns idle");
  };

  check(
    app.compose.classification.querySelector('option[value="shopping"]'),
    "Shopping is an available capture destination",
  );
  check(
    app.staples.composer?.fixedClassification === "staple",
    "Staples has its own capture fixed to Staples",
  );
  // Earlier suites leave other Shopping items behind; address rows by id.
  const rowFor = (list, itemId) => [...list.querySelectorAll("kin-item")].find((node) => node.record?.itemId === itemId) ?? null;
  // One list is shown at a time, so focus assertions need that list's route.
  app.ctx.navigation.navigate("#lists/shopping");
  app.compose.input.value = "Shopping regression item";
  app.compose.classification.value = "shopping";
  app.compose.plan.value = "none";
  app.compose.input.focus();
  app.compose.form.requestSubmit();
  await idle();

  let item = app.state.items.find(
    (record) => record.text === "Shopping regression item",
  );
  check(item?.classification === "shopping", "Shopping classification is replayed");
  check(
    rowFor(app.shopping, item.itemId)?.querySelector(".item-text")?.textContent === item.text &&
      !rowFor(app.needs, item.itemId) && !rowFor(app.staples, item.itemId),
    "Shopping appears only in its dedicated list",
  );

  const complete = rowFor(app.shopping, item.itemId).querySelector(".complete-button");
  complete.focus();
  complete.click();
  await idle();
  item = app.state.items.find(
    (record) => record.text === "Shopping regression item",
  );
  check(item.status === "completed", "Shopping completion is persisted");
  check(
    rowFor(app.shopping, item.itemId).querySelector(".reopen-button") ===
      document.activeElement,
    "List focus follows the completed item's Reopen action",
  );

  rowFor(app.shopping, item.itemId).querySelector(".reopen-button").click();
  await idle();
  check(
    app.state.items.find((record) => record.itemId === item.itemId).status ===
      "active",
    "Shopping item can be reopened",
  );
  app.ctx.detail.openItemDetail(item.itemId);
  check(app.selection?.itemId === item.itemId && app.detail.querySelector(".archive-button"), "details expose Archive for the open item");
  app.detail.querySelector(".archive-button").click();
  await idle();
  check(
    app.state.items.find((record) => record.itemId === item.itemId).status ===
      "archived" &&
      !rowFor(app.shopping, item.itemId),
    "Archived Shopping item is retained but hidden",
  );
  check(app.detail.textContent.includes("archived") && !app.detail.querySelector(".archive-button"), "details explain an archived record instead of offering stale actions");
  app.ctx.detail.closeItemDetail({ restoreFocus: false });

  app.ctx.navigation.navigate("#lists/staples");
  app.staples.composer.input.value = "Laundry detergent";
  app.staples.composer.form.requestSubmit();
  await idle();
  let staple = app.state.items.find(
    (record) => record.text === "Laundry detergent",
  );
  check(
    staple?.classification === "staple" &&
      rowFor(app.staples, staple.itemId)?.querySelector(".item-text")?.textContent === staple.text &&
      !rowFor(app.shopping, staple.itemId),
    "Staples appear only in the reusable Staples list",
  );
  check(
    !rowFor(app.staples, staple.itemId).querySelector(".complete-button") &&
      rowFor(app.staples, staple.itemId).querySelector(".replenish-button"),
    "Staples offer replenishment rather than completion",
  );

  const replenish = rowFor(app.staples, staple.itemId).querySelector(".replenish-button");
  replenish.focus();
  const append = app.store.append;
  let firstAttempt = true;
  let originalCommand;
  let retryCommand;
  app.store.append = async function (...args) {
    if (firstAttempt) {
      firstAttempt = false;
      originalCommand = args[0];
      const error = new Error("Synthetic replenishment storage failure");
      error.code = 5;
      throw error;
    }
    retryCommand = args[0];
    return append.apply(this, args);
  };
  try {
    replenish.click();
    await idle();
    check(
      !app.state.items.some(
        (record) =>
          record.text === staple.text && record.classification === "shopping",
      ) && !app.retryButton.hidden,
      "Failed replenishment is reported without appending a Shopping Item",
    );
    app.retryButton.click();
    await idle();
  } finally {
    app.store.append = append;
  }
  const shoppingCopies = app.state.items.filter(
    (record) =>
      record.text === staple.text && record.classification === "shopping",
  );
  const shoppingCopy = shoppingCopies[0];
  check(
    originalCommand?.id === retryCommand?.id &&
      shoppingCopies.length === 1 &&
      staple.status === "active" &&
      shoppingCopy?.status === "active" &&
      rowFor(app.shopping, shoppingCopy.itemId)?.querySelector(".item-text")?.textContent === staple.text,
    "Retry appends exactly one Shopping Item with the same identity and keeps the staple",
  );
  check(
    rowFor(app.staples, staple.itemId).querySelector(".replenish-button") ===
      document.activeElement,
    "Staples focus returns to Add to Shopping after persistence",
  );

  app.ctx.detail.openItemDetail(staple.itemId);
  app.detail.querySelector(".archive-button").click();
  await idle();
  app.ctx.detail.closeItemDetail({ restoreFocus: false });
  staple = app.state.items.find((record) => record.itemId === staple.itemId);
  check(
    staple.status === "archived" &&
      rowFor(app.staples, staple.itemId) === null &&
      rowFor(app.shopping, shoppingCopy.itemId)?.querySelector(".item-text")?.textContent === shoppingCopy.text,
    "Archiving a staple does not remove its Shopping copy",
  );
  return "PASS Shopping lifecycle and Staples replenishment, isolation, and focus";
}
