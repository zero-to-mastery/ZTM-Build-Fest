// Store sections (#411, ADR 0015) in the browser, through the real store and
// engine: in shopping mode, name sections and save them; give items a
// section from their row; the list groups by section in the household's
// order with Other last; reordering changes the order; a replenished staple
// brings its section with it.
export async function storeSectionsRegressions() {
  const app = document.querySelector("kin-app");
  const check = (condition, message, detail) => {
    if (!condition) throw new Error(`${message}${detail === undefined ? "" : ` ${JSON.stringify(detail)}`}`);
  };
  const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
  const until = async (test, message) => {
    for (let index = 0; index < 900; index++) { if (test()) return; await frame(); }
    check(false, message);
  };
  const idle = () => until(() => !app.busy && !app.refreshing && !app.pendingRefresh && !app.wakePending && !app.ctx.sections.reading, "section work settles");
  const tag = crypto.randomUUID().slice(0, 6);
  const milk = `Milk ${tag}`, bread = `Bread ${tag}`, foil = `Foil ${tag}`, butter = `Butter ${tag}`;
  for (const [text, classification] of [[milk, "shopping"], [bread, "shopping"], [foil, "shopping"], [butter, "staple"]]) {
    await app.ctx.items.handleAddItem({ detail: { text, classification } });
    await idle();
  }
  const id = (text) => app.state.items.find((item) => item.text === text && item.status === "active")?.itemId;
  app.ctx.navigation.navigate("#lists/shopping");
  await frame();
  app.shopping.querySelector(".start-shopping").click();
  await frame();
  const mode = app.shoppingMode;

  // Name two sections and save.
  mode.querySelector(".shopping-mode-sections-toggle").click();
  const editor = mode.querySelector(".shopping-sections-editor");
  check(!editor.hidden && document.activeElement === mode.newSection, "Sections opens the editor at the new-section field");
  for (const name of [`Dairy ${tag}`, `Bakery ${tag}`]) { mode.newSection.value = name; mode.newSection.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); }
  mode.newSection.value = `dairy ${tag}`;
  mode.newSection.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  check(mode.editorMessage.textContent.includes("already a section"), "a duplicate name is refused in place");
  mode.newSection.value = "";
  editor.querySelector(".primary-action").click();
  await idle();
  await until(() => (app.shoppingSections?.sections ?? []).map((section) => section.name).join() === `Dairy ${tag},Bakery ${tag}` && editor.hidden, "the sections are saved in order");

  // Give items sections from their rows.
  const sectionId = (name) => app.shoppingSections.sections.find((section) => section.name === name).sectionId;
  const choose = async (text, name) => {
    const select = mode.querySelector(`.shopping-mode-section[data-section-for="${id(text)}"]`);
    check(select?.getAttribute("aria-label") === `Section for ${text}`, `${text} has a labelled section control`);
    select.value = name ? sectionId(name) : "";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await idle();
  };
  await choose(milk, `Dairy ${tag}`);
  await choose(bread, `Bakery ${tag}`);
  await until(() => app.shoppingSections.itemSections.get(id(bread)) === sectionId(`Bakery ${tag}`), "item sections are saved");
  const order = () => [...mode.list.children].map((node) => node.querySelector("h3")?.textContent ?? node.querySelector(".shopping-mode-text")?.textContent).filter((text) => text === `Dairy ${tag}` || text === `Bakery ${tag}` || text === "Other" || [milk, bread, foil].includes(text));
  await until(() => order().join("|") === `Dairy ${tag}|${milk}|Bakery ${tag}|${bread}|Other|${foil}`, "the list groups by section, Other last");

  // Reorder: Bakery first.
  mode.querySelector(".shopping-mode-sections-toggle").click();
  mode.querySelector(".shopping-sections-list li:nth-child(2) button[aria-label^='Move up']").click();
  editor.querySelector(".primary-action").click();
  await idle();
  await until(() => order().join("|").startsWith(`Bakery ${tag}|${bread}|Dairy ${tag}|${milk}`), "reordering changes the order");
  mode.close();

  // A staple's section goes with it to Shopping.
  app.ctx.navigation.navigate("#lists/staples");
  await frame();
  await app.ctx.sections.setItemSection(id(butter), sectionId(`Dairy ${tag}`));
  await idle();
  await app.ctx.items.handleReplenishStaple({ detail: { itemId: id(butter) } });
  await idle();
  const replenished = app.state.items.find((item) => item.text === butter && item.classification === "shopping");
  await until(() => app.shoppingSections.itemSections.get(replenished?.itemId) === sectionId(`Dairy ${tag}`), "a replenished staple keeps its section");

  // Tidy up: clear the sections and archive the items.
  await app.ctx.sections.saveSections([]);
  await idle();
  for (const item of app.state.items.filter((record) => record.text.endsWith(tag) && record.status !== "archived")) {
    await app.ctx.items.handleItemAction("archive", item.itemId);
    await idle();
  }
  app.ctx.undo.clear();
  app.ctx.navigation.navigate("#today");
  return "PASS store sections: name, refuse duplicates, assign from rows, group with Other last, reorder, staples keep theirs (#411)";
}
