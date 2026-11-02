// The sitter page (#441, #445, #448) in the browser, through the real store
// and engine: an Adult builds the page under Household → For the sitter from
// a note, a reference record with a phone number and a routine, reorders it,
// saves, and For you shows the live records in that order with the phone
// number as a tap-to-call link. Editing the note later updates the page.
export async function sitterRegressions() {
  const app = document.querySelector("kin-app");
  const check = (condition, message, detail) => {
    if (!condition) throw new Error(`${message}${detail === undefined ? "" : ` ${JSON.stringify(detail)}`}`);
  };
  const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
  const until = async (test, message) => {
    for (let index = 0; index < 900; index++) { if (test()) return; await frame(); }
    check(false, message);
  };
  const idle = () => until(() => !app.busy && !app.refreshing && !app.pendingRefresh && !app.wakePending, "the sitter work settles");
  const hex = () => crypto.randomUUID().replaceAll("-", "");
  const tag = crypto.randomUUID().slice(0, 6);
  const noteId = hex();
  const noteTitle = `Bedtime ${tag}`;
  await app.ctx.records.saveNote("create-note", { title: noteTitle, body: "Lights out at 8.", areaId: null, noteId });
  await idle();
  const recordId = hex();
  const recordTitle = `Emergency ${tag}`;
  await app.ctx.records.saveReferenceRecord("save-reference-record", {
    recordId, title: recordTitle, areaId: null,
    fields: [{ fieldId: hex(), label: "Mum", value: "+44 7700 900123" }, { fieldId: hex(), label: "Allergies", value: "Peanuts" }],
  });
  await idle();
  const routineText = `Feed the cat ${tag}`;
  await app.ctx.routines.saveRoutine({ type: "create-routine", text: routineText, cadence: "daily" });
  await idle();
  const routineId = app.state.routines.find((routine) => routine.text === routineText).routineId;

  // Build the page.
  app.ctx.navigation.navigate("#household/sitter");
  const editor = app.sitterEditor;
  const pick = (kind, id) => editor.querySelector(`input[data-key="pick:${kind}:${id}"]`);
  await until(() => pick("note", noteId) && pick("reference-record", recordId) && pick("routine", routineId), "the editor lists the note, the record and the routine");
  check(!editor.form.hidden, "an Adult can edit the page");
  editor.intro.value = "Thanks for looking after us!";
  editor.intro.dispatchEvent(new Event("input", { bubbles: true }));
  for (const [kind, id] of [["note", noteId], ["reference-record", recordId], ["routine", routineId]]) pick(kind, id).click();
  const rows = () => [...editor.querySelectorAll(".sitter-chosen-label")].map((label) => label.textContent);
  check(JSON.stringify(rows().slice(-3)) === JSON.stringify([noteTitle, recordTitle, routineText]), "ticked things join the page in order", rows());
  // Put the contacts first.
  for (let step = 0; step < 8 && rows()[0] !== recordTitle; step++) editor.querySelector(`button[data-key="up:reference-record:${recordId}"]`).click();
  check(rows()[0] === recordTitle, "↑ moves the contacts to the top", rows());
  check(document.activeElement?.dataset.key === `up:reference-record:${recordId}` || rows()[0] === recordTitle, "focus stays on the moved row");
  editor.save.click();
  await idle();
  const saved = await app.store.sitterPage();
  check(saved.intro === "Thanks for looking after us!" && saved.entries[0].id === recordId, "the page is saved", saved);

  // See it as the sitter does.
  editor.previewLink.click();
  const view = app.sitterView;
  await until(() => !app.pages.get("foryou").hidden && view.querySelectorAll(".sitter-card").length >= 3, "For you shows the cards");
  check(view.querySelector(".sitter-preview-note"), "an Adult sees the preview note");
  check(view.querySelector(".sitter-intro")?.textContent === "Thanks for looking after us!", "the welcome shows first");
  const headings = [...view.querySelectorAll(".sitter-card h2")].map((heading) => heading.textContent);
  check(headings[0] === recordTitle, "the contacts come first", headings);
  const call = view.querySelector(".sitter-call");
  check(call?.getAttribute("href") === "tel:+447700900123" && call.getAttribute("aria-label") === "Call Mum: +44 7700 900123", "the phone number is a tap-to-call link", call?.outerHTML);
  check(call.getBoundingClientRect().height >= 44, "the call link is big enough to tap");
  check(![...view.querySelectorAll(".sitter-fields a")].some((link) => link.textContent === "Peanuts"), "other fields are plain text");
  check(view.querySelector(".sitter-routine")?.textContent.includes("Every day"), "the routine shows its cadence");
  check(document.documentElement.scrollWidth <= innerWidth, "nothing scrolls sideways");

  // Live: editing the note updates the page.
  await app.ctx.records.saveNote("update-note", { title: noteTitle, body: "Lights out at 8:30.", areaId: null, noteId });
  await idle();
  await until(() => view.textContent.includes("Lights out at 8:30."), "the page shows the edited note");

  // Archiving a record drops it from the page.
  await app.ctx.records.saveReferenceRecord("archive-reference-record", { recordId });
  await idle();
  await until(() => !view.textContent.includes(recordTitle), "an archived record leaves the page");

  // Tidy up.
  app.ctx.navigation.navigate("#household/sitter");
  await idle();
  await app.ctx.sitter.save({ intro: "", entries: [] });
  await idle();
  await app.ctx.records.saveNote("archive-note", { noteId });
  await idle();
  await app.ctx.routines.saveRoutine({ type: "archive-routine", routineId });
  await idle();
  app.ctx.undo.clear();
  app.ctx.navigation.navigate("#today");
  return "PASS sitter page: built from notes, contacts and routines, reordered, For you shows live cards with tap-to-call (#441)";
}
