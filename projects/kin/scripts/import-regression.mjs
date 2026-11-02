// Bringing lists into Kin (#452, #453, #457) in the browser, through the real
// store and engine: pasting several lines into a capture field offers the
// import; the preview strips bullets, leaves repeats and existing items
// unticked and reads ticked boxes as done; a CSV file maps its columns to
// Shopping, To do, dates and done; Add saves exactly the ticked rows.
export async function importRegressions() {
  const app = document.querySelector("kin-app");
  const check = (condition, message, detail) => {
    if (!condition) throw new Error(`${message}${detail === undefined ? "" : ` ${JSON.stringify(detail)}`}`);
  };
  const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
  const until = async (test, message) => {
    for (let index = 0; index < 900; index++) { if (test()) return; await frame(); }
    check(false, message);
  };
  const dialog = app.importer.querySelector("dialog");
  const tag = crypto.randomUUID().slice(0, 6);
  const has = (text, extra = () => true) => app.state.items.some((item) => item.text === text && extra(item));

  // 1. Pasting several lines into Today's capture field offers the import.
  const input = app.compose.input;
  const clipboard = new DataTransfer();
  clipboard.setData("text/plain", `- Oat milk ${tag}\n- [x] Eggs ${tag}\n\n• Oat milk ${tag}\n`);
  const paste = new ClipboardEvent("paste", { clipboardData: clipboard, bubbles: true, cancelable: true });
  input.dispatchEvent(paste);
  await frame();
  check(paste.defaultPrevented && dialog.open && !app.importer.review.hidden, "pasting a list opens the import preview");
  const rows = () => [...app.importer.rowsList.querySelectorAll("label")];
  check(rows().map((row) => row.querySelector(".import-row-text").textContent).join("|") === `Oat milk ${tag}|Eggs ${tag}|Oat milk ${tag}`, "bullets and checkboxes are removed");
  check(rows().map((row) => row.querySelector("input").checked).join() === "true,true,false", "a repeat is left unticked");
  check(rows()[1].textContent.includes("done"), "a ticked box comes in as done");
  check(app.importer.summary.textContent === "2 things to add · 1 left out" && app.importer.addButton.textContent === "Add 2 items", "the summary counts what will be added", app.importer.summary.textContent);
  app.importer.addButton.click();
  await until(() => !dialog.open && has(`Oat milk ${tag}`) && has(`Eggs ${tag}`, (item) => item.status === "completed"), "Add saves the ticked rows, done ones completed");
  check(app.state.items.filter((item) => item.text === `Oat milk ${tag}`).length === 1, "the repeat wasn't added");
  check(/^Added 2 items to To do\./.test(app.status.textContent), "the status says what was added", app.status.textContent);

  // 2. A CSV file from another app: columns guessed, Shopping and dates read.
  const opener = document.createElement("button");
  app.main.append(opener);
  check(app.ctx.importList.open({ opener }), "Import a list… opens the dialog");
  const csv = `Title,List,Due Date,Completed\n"Bread, sourdough ${tag}",Groceries,,\nFix tap ${tag},Home,2026-11-02,\nOat milk ${tag},Groceries,,\n`;
  check(app.querySelectorAll('input[type="file"]').length === 1, "the import dialog keeps no file input of its own");
  await app.importer.readFile(new File([csv], "export.csv", { type: "text/csv" }));
  await until(() => !app.importer.review.hidden, "choosing a CSV shows the preview");
  check(!app.importer.mapping.hidden && app.importer.selects.text.value === "0" && app.importer.selects.date.value === "2", "the columns are guessed");
  check(rows()[0].textContent.includes("Shopping") && rows()[1].textContent.includes("To do") && rows()[1].querySelector(".import-row-meta").textContent.includes("2026"), "a groceries list goes to Shopping, dates are read");
  check(rows()[2].querySelector("input").checked === false && rows()[2].textContent.includes("already in Kin"), "something already in Kin is left unticked");
  app.importer.addButton.click();
  await until(() => !dialog.open && has(`Bread, sourdough ${tag}`, (item) => item.classification === "shopping") && has(`Fix tap ${tag}`, (item) => item.planningDate === 20261102), "the CSV rows are saved");
  check(document.activeElement === opener, "focus returns to the opener");
  opener.remove();

  // 3. A single line pastes normally.
  const one = new DataTransfer();
  one.setData("text/plain", "just one thing");
  const single = new ClipboardEvent("paste", { clipboardData: one, bubbles: true, cancelable: true });
  input.dispatchEvent(single);
  check(!single.defaultPrevented && !dialog.open, "a single line is pasted as usual");

  // Tidy up.
  for (const text of [`Oat milk ${tag}`, `Eggs ${tag}`, `Bread, sourdough ${tag}`, `Fix tap ${tag}`]) {
    const item = app.state.items.find((record) => record.text === text && record.status !== "archived");
    if (item) { await app.ctx.items.handleItemAction("archive", item.itemId); await until(() => !app.busy, "archive settles"); }
  }
  app.ctx.undo.clear();
  return "PASS import: paste a list into capture, preview with repeats and done, CSV columns, Shopping and dates (#452)";
}
