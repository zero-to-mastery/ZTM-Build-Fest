// Sharing into Kin (#389, #390, #395) inside the browser, through the real
// store and engine: "Add to Kin" shows what was shared and where it can go;
// Shopping and a note go through the same dialog and commands as turning a
// chat message into a record; a shared photo is offered as an attachment;
// Cancel adds nothing. (The service worker's side is unit-tested in
// web/service-worker.test.mjs, the address handling in share-target.test.mjs.)
export async function shareRegressions() {
  const app = document.querySelector("kin-app");
  const check = (condition, message, detail) => {
    if (!condition) throw new Error(`${message}${detail === undefined ? "" : ` ${JSON.stringify(detail)}`}`);
  };
  const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
  const until = async (test, message) => {
    for (let index = 0; index < 600; index++) { if (test()) return; await frame(); }
    check(false, message);
  };
  const sheet = app.shareSheet.querySelector("dialog");
  const recordDialog = app.chatShare.querySelector("dialog");
  const kinds = () => [...sheet.querySelectorAll("[data-kind]")].map((button) => button.dataset.kind).join();

  // 1. A link shared to Shopping.
  const title = `Shared ${crypto.randomUUID().slice(0, 8)}`;
  let offering = app.ctx.share.offer({ title, text: "", url: "https://example.test/pancakes", files: [] });
  await frame();
  check(sheet.open && sheet.querySelector("h2").textContent === "Add to Kin", "Add to Kin opens");
  check(sheet.querySelector(".share-sheet-preview").textContent.includes(title), "it shows what was shared", sheet.textContent);
  check(/^todo,shopping,note,handoff(,chat)?$/.test(kinds()), "it offers the destinations", kinds());
  check(document.activeElement === sheet.querySelector("[data-kind]"), "focus starts on the first destination");
  sheet.querySelector('[data-kind="shopping"]').click();
  await offering;
  await frame();
  check(!sheet.open && recordDialog.open, "choosing Shopping opens the Shopping dialog");
  check(app.chatShare.input.value === `${title} https://example.test/pancakes`, "the item is prefilled with the title and link", app.chatShare.input.value);
  check(app.chatShare.audience.textContent === "Everyone in your household will see this.", "no talk of a chat message", app.chatShare.audience.textContent);
  app.chatShare.form.requestSubmit();
  await until(() => app.state.items.some((item) => item.text === `${title} https://example.test/pancakes` && item.classification === "shopping"), "the shared link is saved to Shopping");
  recordDialog.close();
  await frame();

  // 2. A photo shared as a note: the file is offered as an attachment.
  const photo = new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4])], "school-letter.jpg", { type: "image/jpeg" });
  offering = app.ctx.share.offer({ title: "", text: "Trip form\nDue Friday", url: "", files: [photo] });
  await frame();
  check(sheet.querySelector(".share-sheet-files")?.textContent.includes("school-letter.jpg"), "the shared file is listed");
  sheet.querySelector('[data-kind="note"]').click();
  await offering;
  await frame();
  check(recordDialog.open && app.chatShare.input.value === "Trip form" && app.chatShare.body.value === "Trip form\nDue Friday", "a note gets the first line as its title and the rest as its body",
    { title: app.chatShare.input.value, body: app.chatShare.body.value });
  check(recordDialog.textContent.includes("school-letter.jpg"), "the photo is offered as an attachment");
  recordDialog.close();
  await frame();

  // 3. Cancel adds nothing, and says so.
  const before = app.state.items.length;
  offering = app.ctx.share.offer({ title: "Not wanted", text: "", url: "", files: [] });
  await frame();
  sheet.dispatchEvent(new Event("cancel", { cancelable: true }));
  await offering;
  check(!sheet.open && !recordDialog.open && app.state.items.length === before && app.status.textContent === "Nothing was added.", "Cancel adds nothing");

  // 4. An empty share doesn't open anything.
  await app.ctx.share.offer({ title: "", text: "  ", url: "", files: [] });
  check(!sheet.open && app.status.textContent === "Nothing came through to add.", "an empty share says so");
  return "PASS sharing into Kin: Add to Kin, Shopping with a link, a note with a photo, cancel and empty shares (#389)";
}
