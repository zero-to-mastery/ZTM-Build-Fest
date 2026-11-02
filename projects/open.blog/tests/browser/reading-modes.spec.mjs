import { test, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { removeTree } from "./teardown.mjs";

// The published page of a post with author-written supplements (ADRs 0140-0143) from the real build
// and the real stylesheet and component: the standard, guided and deep-dive controls by keyboard
// and screen-reader name, state and description, a page that is complete without JavaScript, the
// choice kept on the device (and the page working when storage is blocked), reduced motion, a
// 320 CSS pixel and 320 by 256 (the viewport 400% zoom leaves) reflow measured on the article region, a warning that no mode hides,
// and links into a hidden supplement.

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const binary = join(repository, "target", "debug", process.platform === "win32" ? "openblog.exe" : "openblog");
const contract = JSON.parse(readFileSync(join(repository, "tests", "fixtures", "reading-modes.json"), "utf8"));
const STORAGE_KEY = contract.storageKey;
const LONG_WORD = "Supercalifragilistic".repeat(8);
const LIBRARY = JSON.stringify({
  version: 1,
  sources: [
    { id: "plato-republic", kind: "work", title: "Politeia", creators: [{ name: "Plato", role: "author" }] },
    { id: "slings-2003", kind: "edition", of: "plato-republic", title: "Platonis Rempublicam", issued: "2003" },
  ],
});
const FILLER = Array.from({ length: 40 }, (_, index) => `Filler paragraph ${index + 1} keeps the article long enough to scroll.\n`).join("\n");
const BODY = `The article opens here and never changes.

> [!supplement kind=definition level=guided] Aporia
> A state of puzzlement. ${LONG_WORD}

The argument goes on [@plato-republic]. See [the manuscripts](#ob-supplement-2-h1).

<details><summary>An aside</summary>Aside words stay open.</details>

> [!supplement kind=evidence level=deep-dive] The manuscripts
> ### Manuscripts
> Three witnesses agree [@slings-2003].
>
> > [!supplement kind=further-reading]
> > Read the edition.

> [!supplement kind=context] Handling
> Notes before the warning.
>
> > [!WARNING]
> > Do not heat the mixture.

${FILLER}
The article ends here.
`;
const post = (title, front) => `---\ntitle: ${title}\ndate: 2026-10-20\n${front}citations: notes\n---\n${BODY}`;
let root;
let server;
let origin;

test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "openblog-reading-modes-"));
  cpSync(join(repository, "examples", "portable-publishing"), root, { recursive: true });
  const library = join(root, ".openblog", "private", "research", "sources.json");
  mkdirSync(dirname(library), { recursive: true });
  writeFileSync(library, LIBRARY);
  writeFileSync(join(root, "content", "posts", "modes.md"), post("Reading modes", "readingModes: true\n"));
  writeFileSync(join(root, "content", "posts", "guided.md"), post("Opens guided", "readingModes: {default: guided}\n"));
  writeFileSync(
    join(root, "content", "posts", "callout.md"),
    "---\ntitle: In a warning\ndate: 2026-10-20\nreadingModes: true\n---\nBefore.\n\n> [!WARNING]\n> Check the label first.\n>\n> > [!supplement kind=context level=deep-dive] Why it matters\n> > The label names the allergen.\n\nAfter.\n",
  );
  writeFileSync(
    join(root, "content", "posts", "uncertain.md"),
    "---\ntitle: Uncertain\ndate: 2026-10-20\nreadingModes: true\n---\nScholars are unsure whether the text is early. That doubt belongs to the article.\n\n> [!supplement kind=uncertainty level=guided] What is not known\n> The dating rests on one witness.\n\n> [!CAUTION]\n> The reading is disputed.\n>\n> > [!supplement kind=uncertainty level=deep-dive] Why it is disputed\n> > The witnesses disagree.\n\nThe article ends.\n",
  );
  writeFileSync(
    join(root, "content", "posts", "nested.md"),
    "---\ntitle: Nested\ndate: 2026-10-20\nreadingModes: true\n---\nOpening.\n\n> [!supplement kind=context level=guided] Outer\n> Outer words.\n>\n> > [!supplement kind=evidence level=deep-dive] Inner\n> > Inner words.\n\nClosing.\n",
  );
  // A theme from before reading modes: its own stylesheet flattens block quotes and knows no supplement hook.
  mkdirSync(join(root, "themes", "legacy"), { recursive: true });
  writeFileSync(join(root, "themes", "legacy", "theme.json"), JSON.stringify({ label: "Legacy", extends: "base", stylesheets: ["legacy.css"] }));
  writeFileSync(join(root, "themes", "legacy", "legacy.css"), "blockquote { border: 0; margin: 0; padding: 0; background: none; }\np { margin: 0 0 1em; }\n");
  writeFileSync(join(root, "content", "posts", "legacy.md"), post("Legacy theme", "readingModes: true\ntheme: legacy\n"));
  writeFileSync(join(root, "content", "posts", "plain.md"), "---\ntitle: Plain\ndate: 2026-10-20\n---\nNo supplements here.\n\n> An ordinary quote.\n");
  const listener = createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const port = listener.address().port;
  await new Promise((done) => listener.close(done));
  origin = `http://127.0.0.1:${port}`;
  server = spawn(binary, ["serve", "--root", root, "--port", String(port)], { cwd: repository, stdio: "pipe" });
  let output = "";
  server.stdout.on("data", (data) => { output += data; });
  server.stderr.on("data", (data) => { output += data; });
  await expect(async () => {
    if (server.exitCode !== null) throw new Error(`Test server exited: ${output}`);
    expect((await fetch(`${origin}/modes/`)).ok).toBe(true);
  }).toPass({ timeout: 30000 });
});

test.afterAll(async () => {
  if (server && server.exitCode === null) {
    const stopped = once(server, "exit");
    server.kill();
    await stopped;
  }
  removeTree(root);
});

const control = (page) => page.getByRole("group", { name: "Reading mode", exact: true });
const radio = (page, name) => page.getByRole("radio", { name, exact: true });
const supplement = (page, id) => page.locator(`#ob-supplement-${id}`);
const visibleSupplements = (page) =>
  page
    .locator(".ob-supplement")
    .evaluateAll((nodes) => nodes.filter((node) => !node.hasAttribute("hidden") && node.checkVisibility()).map((node) => node.id));
const stored = (page) => page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY);

async function open(page, slug = "modes", hash = "") {
  await page.goto(`${origin}/${slug}/${hash}`);
  await expect(control(page)).toBeVisible();
}

test("without JavaScript every supplement is written out visible, labelled and bounded, and no control exists", async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await page.goto(`${origin}/modes/`);
  await expect(page.locator("ob-reading-modes")).toHaveAttribute("default", "standard");
  await expect(control(page)).toHaveCount(0);
  expect(await visibleSupplements(page)).toEqual(["ob-supplement-1", "ob-supplement-2", "ob-supplement-3", "ob-supplement-4"]);
  await expect(page.getByText("Do not heat the mixture.")).toBeVisible();
  await expect(page.getByText("Read the edition.")).toBeVisible();
  // Each supplement is a named group that starts with its label and ends with an end line.
  await expect(page.getByRole("group", { name: /Definition guided supplement Aporia/ })).toBeVisible();
  for (const end of ["definition", "evidence", "further reading", "context"]) {
    await expect(page.getByText(`End of ${end} supplement.`, { exact: true })).toBeVisible();
  }
  expect(await page.locator("[hidden].ob-supplement").count()).toBe(0);
  // The labelled quote is real structure, so it still reads as set apart with no stylesheet.
  await expect(page.locator("#ob-supplement-1 > blockquote")).toBeVisible();
  // A real heading inside a supplement, outside the table of contents.
  await expect(page.locator("#ob-supplement-2-h1")).toHaveText("Manuscripts");
  await context.close();
});

test("a post without supplements has no reading-mode element at all", async ({ page }) => {
  await page.goto(`${origin}/plain/`);
  await expect(page.getByRole("heading", { level: 1, name: "Plain" })).toBeVisible();
  await expect(page.locator("ob-reading-modes")).toHaveCount(0);
  await expect(control(page)).toHaveCount(0);
});

test("the group, its radios, their states and descriptions have screen-reader names", async ({ page }) => {
  await open(page);
  await expect(page.getByRole("radio")).toHaveCount(3);
  for (const name of ["Standard", "Guided", "Deep dive"]) await expect(radio(page, name)).toBeVisible();
  // Standard unless the author chose another default; only one is selected.
  await expect(radio(page, "Standard")).toBeChecked();
  await expect(radio(page, "Guided")).not.toBeChecked();
  await expect(radio(page, "Deep dive")).not.toBeChecked();
  await expect(radio(page, "Standard")).toHaveAccessibleDescription(/The article, with 1 supplement that holds a warning\./);
  await expect(radio(page, "Guided")).toHaveAccessibleDescription(/short explanations: 2 of 4 supplements shown/);
  await expect(radio(page, "Deep dive")).toHaveAccessibleDescription(/everything the author added: 4 of 4 supplements shown/);
  await expect(page.getByRole("button", { name: "Use the author’s default" })).toBeDisabled();
  // Nothing is saved until the reader chooses.
  expect(await stored(page)).toBeNull();
});

test("standard hides the supplements but never a warning; guided and deep dive show more", async ({ page }) => {
  await open(page);
  expect(await visibleSupplements(page)).toEqual(["ob-supplement-4"]);
  await expect(page.getByText("Do not heat the mixture.")).toBeVisible();
  await expect(supplement(page, 4)).toHaveAttribute("data-ob-always", "");
  await radio(page, "Guided").check();
  expect(await visibleSupplements(page)).toEqual(["ob-supplement-1", "ob-supplement-4"]);
  await radio(page, "Deep dive").check();
  expect(await visibleSupplements(page)).toEqual(["ob-supplement-1", "ob-supplement-2", "ob-supplement-3", "ob-supplement-4"]);
  await radio(page, "Standard").check();
  expect(await visibleSupplements(page)).toEqual(["ob-supplement-4"]);
  await expect(page.getByText("Do not heat the mixture.")).toBeVisible();
});

test("the article is the same words, headings and citations in every mode", async ({ page }) => {
  await open(page);
  const article = () =>
    page.locator(".ob-prose").evaluate((node) => {
      const copy = node.cloneNode(true);
      copy.querySelectorAll(".ob-supplement").forEach((item) => item.remove());
      return {
        text: copy.textContent.replace(/\s+/g, " ").trim(),
        headings: [...copy.querySelectorAll("h1,h2,h3,h4,h5,h6")].map((heading) => `${heading.id}:${heading.textContent}`),
        notes: [...copy.querySelectorAll(".footnote-definition")].map((item) => item.id),
      };
    });
  const standard = await article();
  expect(standard.text).toContain("The article opens here and never changes.");
  for (const name of ["Guided", "Deep dive", "Standard"]) {
    await radio(page, name).check();
    expect(await article()).toEqual(standard);
  }
});

test("keyboard: arrows move inside the group and select, Tab leaves it, nothing traps focus", async ({ page }) => {
  await open(page);
  await radio(page, "Standard").focus();
  await page.keyboard.press("ArrowRight");
  await expect(radio(page, "Guided")).toBeChecked();
  await expect(radio(page, "Guided")).toBeFocused();
  expect(await visibleSupplements(page)).toEqual(["ob-supplement-1", "ob-supplement-4"]);
  await page.keyboard.press("ArrowRight");
  await expect(radio(page, "Deep dive")).toBeChecked();
  await page.keyboard.press("ArrowLeft");
  await expect(radio(page, "Guided")).toBeChecked();
  // The group is one tab stop; the next Tab reaches the reset button and the one after leaves.
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Use the author’s default" })).toBeFocused();
  await page.keyboard.press("Tab");
  expect(await control(page).evaluate((group) => group.contains(document.activeElement))).toBe(false);
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Shift+Tab");
  await expect(radio(page, "Guided")).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  expect(await control(page).evaluate((group) => group.contains(document.activeElement))).toBe(false);
});

test("a change is announced to screen readers in one polite status region", async ({ page }) => {
  await open(page);
  await expect(page.locator("ob-reading-modes [role=status]")).toHaveText("");
  await radio(page, "Guided").check();
  await expect(page.locator("ob-reading-modes [role=status]")).toHaveText("Guided reading. Showing 2 of 4 supplements.");
  await radio(page, "Deep dive").check();
  await expect(page.locator("ob-reading-modes [role=status]")).toHaveText("Deep dive reading. Showing 4 of 4 supplements.");
  await radio(page, "Standard").check();
  await expect(page.locator("ob-reading-modes [role=status]")).toHaveText("Standard reading. Showing 1 of 4 supplements.");
  await expect(page.locator("ob-reading-modes [role=status]")).toHaveAttribute("aria-live", "polite");
  await expect(page.locator("ob-reading-modes [role=status]")).toHaveCount(1);
});

test("the choice is kept on this device, is resettable, and nothing is sent anywhere", async ({ page }) => {
  const requests = [];
  page.on("request", (request) => requests.push(request));
  await open(page);
  await radio(page, "Deep dive").check();
  expect(await stored(page)).toBe("deep-dive");
  await page.reload();
  await expect(radio(page, "Deep dive")).toBeChecked();
  expect(await visibleSupplements(page)).toHaveLength(4);
  const reset = page.getByRole("button", { name: "Use the author’s default" });
  await expect(reset).toBeEnabled();
  await reset.click();
  await expect(radio(page, "Standard")).toBeChecked();
  expect(await stored(page)).toBeNull();
  await expect(page.locator("ob-reading-modes [role=status]")).toContainText("Your saved choice was cleared.");
  await expect(reset).toBeDisabled();
  // A value that is not a mode is ignored, not trusted.
  await page.evaluate((key) => localStorage.setItem(key, "<img src=x onerror=alert(1)>"), STORAGE_KEY);
  await page.reload();
  await expect(radio(page, "Standard")).toBeChecked();
  // Nothing was sent: no write of any kind, and no address carries the mode or the key.
  expect(requests.filter((request) => request.method() !== "GET")).toEqual([]);
  const addresses = requests.map((request) => new URL(request.url())).filter((url) => !url.pathname.endsWith(".js"));
  expect(addresses.some((url) => `${url.search}${url.hash}`.includes("deep-dive") || url.href.includes("deep-dive"))).toBe(false);
});

test("the author's default opens the post and reset returns to it; a saved choice wins", async ({ page }) => {
  await open(page, "guided");
  await expect(radio(page, "Guided")).toBeChecked();
  expect(await visibleSupplements(page)).toEqual(["ob-supplement-1", "ob-supplement-4"]);
  await radio(page, "Deep dive").check();
  await page.reload();
  await expect(radio(page, "Deep dive")).toBeChecked();
  await page.getByRole("button", { name: "Use the author’s default" }).click();
  await expect(radio(page, "Guided")).toBeChecked();
  expect(await stored(page)).toBeNull();
});

// A second site whose openblog.json names a default reading mode: the site default applies to a post
// that opts in and writes none, the post's own default wins, and a post that does not opt in is untouched.
test("the site's default reading mode opens a post that names none; the post's own default wins", async ({ page }) => {
  const other = mkdtempSync(join(tmpdir(), "openblog-reading-site-default-"));
  let child;
  try {
    cpSync(join(repository, "examples", "portable-publishing"), other, { recursive: true });
    const configPath = join(other, "openblog.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    config.readingModes = { default: "guided" };
    writeFileSync(configPath, JSON.stringify(config, null, 2));
    for (const [name, front] of [["site", "readingModes: true\n"], ["own", "readingModes: {default: deep-dive}\n"], ["standard", "readingModes: {default: standard}\n"]]) {
      writeFileSync(join(other, "content", "posts", `${name}.md`), post(`Site default ${name}`, front).replace("citations: notes\n", ""));
    }
    const listener = createServer();
    listener.listen(0, "127.0.0.1");
    await once(listener, "listening");
    const port = listener.address().port;
    await new Promise((done) => listener.close(done));
    child = spawn(binary, ["serve", "--root", other, "--port", String(port)], { cwd: repository, stdio: "pipe" });
    let output = "";
    child.stdout.on("data", (data) => { output += data; });
    child.stderr.on("data", (data) => { output += data; });
    const base = `http://127.0.0.1:${port}`;
    await expect(async () => {
      if (child.exitCode !== null) throw new Error(`Test server exited: ${output}`);
      expect((await fetch(`${base}/site/`)).ok).toBe(true);
    }).toPass({ timeout: 30000 });
    const opens = async (slug, mode, shown) => {
      await page.goto(`${base}/${slug}/`);
      await expect(control(page)).toBeVisible();
      await expect(radio(page, mode)).toBeChecked();
      expect(await visibleSupplements(page)).toEqual(shown);
    };
    await opens("site", "Guided", ["ob-supplement-1", "ob-supplement-4"]);
    await opens("own", "Deep dive", ["ob-supplement-1", "ob-supplement-2", "ob-supplement-3", "ob-supplement-4"]);
    await opens("standard", "Standard", ["ob-supplement-4"]);
    // The reader's saved choice still wins over the site default, and reset returns to it.
    await page.goto(`${base}/site/`);
    await radio(page, "Deep dive").check();
    await page.reload();
    await expect(radio(page, "Deep dive")).toBeChecked();
    await page.getByRole("button", { name: "Use the author’s default" }).click();
    await expect(radio(page, "Guided")).toBeChecked();
  } finally {
    if (child && child.exitCode === null) {
      const stopped = once(child, "exit");
      child.kill();
      await stopped;
    }
    rmSync(other, { recursive: true, force: true });
  }
});

test("blocked storage never breaks the page and the announcement says the choice was not saved", async ({ page }) => {
  await page.addInitScript(() => {
    const deny = () => { throw new DOMException("denied", "SecurityError"); };
    Storage.prototype.getItem = deny;
    Storage.prototype.setItem = deny;
    Storage.prototype.removeItem = deny;
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await open(page);
  await expect(radio(page, "Standard")).toBeChecked();
  await radio(page, "Guided").check();
  expect(await visibleSupplements(page)).toEqual(["ob-supplement-1", "ob-supplement-4"]);
  await expect(page.locator("ob-reading-modes [role=status]")).toContainText("could not be saved on this device");
  await page.getByRole("button", { name: "Use the author’s default" }).waitFor({ state: "attached" });
  expect(errors).toEqual([]);
});

test("motion: supplements fade in only when the reader has not asked for reduced motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await open(page);
  await radio(page, "Guided").check();
  expect(await supplement(page, 1).evaluate((node) => getComputedStyle(node).animationName)).toBe("ob-supplement-in");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await radio(page, "Standard").check();
  await radio(page, "Guided").check();
  expect(await supplement(page, 1).evaluate((node) => getComputedStyle(node).animationName)).toBe("none");
  expect(await supplement(page, 1).evaluate((node) => getComputedStyle(node).transitionDuration)).toMatch(/^0s/);
});

test("a link into a hidden supplement shows it, moves focus and says so", async ({ page }) => {
  await open(page, "modes", "#ob-supplement-2-h1");
  await expect(supplement(page, 2)).toBeVisible();
  await expect(page.locator("#ob-supplement-2-h1")).toBeVisible();
  await expect(page.locator("#ob-supplement-2-h1")).toBeFocused();
  await expect(page.locator("ob-reading-modes [role=status]")).toContainText("Showed the evidence supplement");
  // Only what the link needs: the other hidden supplement stays hidden, the mode is unchanged.
  await expect(supplement(page, 1)).toBeHidden();
  await expect(radio(page, "Standard")).toBeChecked();
  // Choosing a mode puts the reader's choice back in charge.
  await radio(page, "Guided").check();
  await expect(supplement(page, 2)).toBeHidden();
});

test("a note cited only inside a supplement names it, and following that note shows the supplement", async ({ page }) => {
  await open(page);
  const note = page.locator("[data-ob-supplement]:not(.ob-supplement)");
  await expect(note).toHaveCount(1);
  await expect(note).toHaveAttribute("data-ob-supplement", "ob-supplement-2");
  const id = await note.getAttribute("id");
  await expect(supplement(page, 2)).toBeHidden();
  await page.evaluate((target) => { location.hash = `#${target}`; }, id);
  await expect(supplement(page, 2)).toBeVisible();
  // The back-link from the note lands on the marker inside the supplement.
  await note.getByRole("link", { name: /Back/ }).click();
  await expect(supplement(page, 2)).toBeVisible();
  // The article's own note is not tied to a supplement.
  await expect(page.locator(".footnote-definition:not([data-ob-supplement])")).toHaveCount(1);
});

test("at 320 CSS pixels the article region reflows with no sideways scrolling in any mode", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await open(page);
  for (const name of ["Standard", "Guided", "Deep dive"]) {
    await radio(page, name).check();
    const measured = await page.evaluate(() => {
      const article = document.querySelector("article");
      const group = document.querySelector(".ob-reading-controls").getBoundingClientRect();
      const box = article.getBoundingClientRect();
      const wide = [...article.querySelectorAll("*")].filter((node) => node.checkVisibility() && node.getBoundingClientRect().right > box.right + 1);
      return {
        page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        article: article.scrollWidth - article.clientWidth,
        groupFits: group.left >= box.left - 1 && group.right <= box.right + 1,
        overflowing: wide.map((node) => node.tagName + "." + node.className),
      };
    });
    expect(measured.page, name).toBeLessThanOrEqual(0);
    expect(measured.article, name).toBeLessThanOrEqual(0);
    expect(measured.groupFits, name).toBe(true);
    expect(measured.overflowing, name).toEqual([]);
  }
});

test("in the 320 by 256 CSS pixel viewport that 400% zoom gives, the control still reaches, labels and operates every option", async ({ browser }) => {
  // 400% zoom of a 1280 pixel window leaves a 320 by 256 CSS pixel viewport at four device pixels per pixel. This
  // emulates that viewport and scale; it is not the browser's own zoom command.
  const context = await browser.newContext({ viewport: { width: 320, height: 256 }, deviceScaleFactor: 4 });
  const page = await context.newPage();
  await open(page);
  for (const name of ["Standard", "Guided", "Deep dive"]) {
    const option = radio(page, name);
    await option.scrollIntoViewIfNeeded();
    await expect(option).toBeVisible();
    const label = page.getByText(name, { exact: true }).first();
    const box = await label.boundingBox();
    expect(box.height).toBeGreaterThanOrEqual(24);
    expect(box.x + box.width).toBeLessThanOrEqual(320 + 1);
  }
  await page.getByText("Deep dive", { exact: true }).first().click();
  await expect(radio(page, "Deep dive")).toBeChecked();
  expect(await visibleSupplements(page)).toHaveLength(4);
  const overflow = await page.evaluate(() => document.querySelector("article").scrollWidth - document.querySelector("article").clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await context.close();
});

test("a supplement written inside a warning callout is shown in every mode", async ({ page }) => {
  await open(page, "callout");
  const inside = supplement(page, 1);
  await expect(inside).toHaveAttribute("data-ob-always", "");
  await expect(inside).toBeVisible();
  await expect(page.getByText("The label names the allergen.")).toBeVisible();
  await expect(page.getByText("Check the label first.")).toBeVisible();
  for (const name of ["Guided", "Deep dive", "Standard"]) {
    await radio(page, name).check();
    await expect(inside, name).toBeVisible();
  }
});

test("a change to another key, or to the mode already shown, leaves a supplement the reader went into shown; one holding focus is never hidden", async ({ page }) => {
  await open(page, "modes", "#ob-supplement-2-h1");
  await expect(page.locator("#ob-supplement-2-h1")).toBeFocused();
  // With focus elsewhere, only the guard on the key and the mode keeps it shown.
  await page.evaluate(() => document.activeElement.blur());
  await page.evaluate(() => window.dispatchEvent(new StorageEvent("storage", { key: "something-else", newValue: "x" })));
  await expect(supplement(page, 2)).toBeVisible();
  // The key is ours but the mode is the one already shown (nothing is saved: standard).
  await page.evaluate((key) => window.dispatchEvent(new StorageEvent("storage", { key })), STORAGE_KEY);
  await expect(supplement(page, 2)).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new StorageEvent("storage", { key: null })));
  await expect(supplement(page, 2)).toBeVisible();
  // Another tab chooses guided, which would hide this deep-dive supplement: not the one holding focus.
  await page.locator("#ob-supplement-2-h1").focus();
  await page.evaluate((key) => {
    localStorage.setItem(key, "guided");
    window.dispatchEvent(new StorageEvent("storage", { key, newValue: "guided" }));
  }, STORAGE_KEY);
  await expect(radio(page, "Guided")).toBeChecked();
  await expect(supplement(page, 2)).toBeVisible();
  await expect(page.locator("#ob-supplement-2-h1")).toBeFocused();
  await expect(supplement(page, 1)).toBeVisible();
  await page.evaluate((key) => localStorage.removeItem(key), STORAGE_KEY);
});

test("the reset button keeps keyboard focus when it has nothing left to reset", async ({ page }) => {
  await open(page);
  await radio(page, "Guided").check();
  const reset = page.getByRole("button", { name: "Use the author’s default" });
  await expect(reset).toBeEnabled();
  await reset.focus();
  await page.keyboard.press("Enter");
  await expect(radio(page, "Standard")).toBeChecked();
  await expect(reset).toBeDisabled();
  await expect(reset).toHaveAttribute("aria-disabled", "true");
  await expect(reset).toBeFocused();
  // Pressing it again does nothing.
  await page.keyboard.press("Enter");
  await expect(reset).toBeFocused();
});

test("a click on a link to the address already shown reveals the supplement it points into", async ({ page }) => {
  await open(page, "modes", "#ob-supplement-2-h1");
  await expect(supplement(page, 2)).toBeVisible();
  await radio(page, "Guided").check();
  await expect(supplement(page, 2)).toBeHidden();
  // The address still says #ob-supplement-2-h1, so following the link fires no hashchange.
  expect(new URL(page.url()).hash).toBe("#ob-supplement-2-h1");
  await page.getByRole("link", { name: "the manuscripts" }).click();
  await expect(supplement(page, 2)).toBeVisible();
  await expect(page.locator("#ob-supplement-2-h1")).toBeFocused();
  await expect(page.locator("ob-reading-modes [role=status]")).toContainText("Showed the evidence supplement");
});

test("an element put back in the page listens again", async ({ page }) => {
  await open(page);
  await page.evaluate(() => {
    const element = document.querySelector("ob-reading-modes");
    const parent = element.parentNode;
    const next = element.nextSibling;
    element.remove();
    parent.insertBefore(element, next);
  });
  await expect(control(page)).toHaveCount(1);
  await radio(page, "Guided").check();
  expect(await visibleSupplements(page)).toEqual(["ob-supplement-1", "ob-supplement-4"]);
  // The address listener works after the move...
  await page.evaluate(() => { location.hash = "#ob-supplement-2-h1"; });
  await expect(supplement(page, 2)).toBeVisible();
  // ...and so does the one for another tab's choice.
  await page.evaluate((key) => {
    localStorage.setItem(key, "standard");
    window.dispatchEvent(new StorageEvent("storage", { key, newValue: "standard" }));
  }, STORAGE_KEY);
  await expect(radio(page, "Standard")).toBeChecked();
  await page.evaluate((key) => localStorage.removeItem(key), STORAGE_KEY);
});

test("a site under a folder keeps its choice under its base path, not the shared origin's key", async ({ page }) => {
  await open(page);
  await page.evaluate(() => {
    const original = document.querySelector("ob-reading-modes");
    const copy = original.cloneNode(true);
    copy.setAttribute("data-ob-base", "/blog");
    original.replaceWith(copy);
  });
  await expect(control(page)).toHaveCount(1);
  await radio(page, "Deep dive").check();
  expect(await stored(page)).toBeNull();
  expect(await page.evaluate((key) => localStorage.getItem(`${key}:/blog`), STORAGE_KEY)).toBe("deep-dive");
  await page.evaluate((key) => localStorage.removeItem(`${key}:/blog`), STORAGE_KEY);
});

test("a hidden supplement stays findable and a link into it still shows it", async ({ page }) => {
  await open(page);
  // Chromium has hidden=until-found: the words are in the page, skipped until something needs them.
  await expect(supplement(page, 2)).toHaveAttribute("hidden", "until-found");
  await expect(page.getByText("Three witnesses agree", { exact: false })).toBeHidden();
  await page.evaluate(() => { location.hash = "#ob-supplement-2-h1"; });
  await expect(supplement(page, 2)).toBeVisible();
  await expect(supplement(page, 2)).not.toHaveAttribute("hidden");
  await expect(supplement(page, 2)).toHaveAttribute("data-ob-revealed", "");
  await expect(page.locator("ob-reading-modes [role=status]")).toContainText("Showed the evidence supplement");
});

test("layers the author's default hides are hidden before script runs, and return if script never does", async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.route(/\/assets\/.*\.js/, (route) => route.abort());
  await page.goto(`${origin}/modes/`);
  await expect(page.locator("ob-reading-modes")).toHaveAttribute("default", "standard");
  expect(await page.evaluate(() => customElements.get("ob-reading-modes") === undefined)).toBe(true);
  const shown = () =>
    page.locator(".ob-supplement").evaluateAll((nodes) =>
      nodes.map((node) => ({ id: node.id, shown: getComputedStyle(node).visibility !== "hidden" && node.getBoundingClientRect().height > 0 })),
    );
  // No script yet: standard hides the three ordinary layers, never the warning.
  expect((await shown()).filter((item) => item.shown).map((item) => item.id)).toEqual(["ob-supplement-4"]);
  // Without the script nothing is lost for good: every layer comes back by itself.
  await expect(async () => {
    expect((await shown()).every((item) => item.shown)).toBe(true);
  }).toPass({ timeout: 15000 });
  await context.close();
});

test("a post that opens guided hides only its deep-dive layers before script runs", async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.route(/\/assets\/.*\.js/, (route) => route.abort());
  await page.goto(`${origin}/guided/`);
  const shown = await page.locator(".ob-supplement").evaluateAll((nodes) =>
    nodes.filter((node) => getComputedStyle(node).visibility !== "hidden" && node.getBoundingClientRect().height > 0).map((node) => node.id),
  );
  expect(shown).toEqual(["ob-supplement-1", "ob-supplement-4"]);
  await context.close();
});

test("with reduced motion off nothing fades in on load; only a chosen mode does", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await open(page, "guided");
  const animations = () =>
    page.locator(".ob-supplement").evaluateAll((nodes) => nodes.map((node) => getComputedStyle(node).animationName));
  expect((await animations()).every((name) => name === "none")).toBe(true);
  await radio(page, "Deep dive").check();
  expect((await animations()).filter((name) => name === "ob-supplement-in")).toHaveLength(2);
});

test("changing the mode keeps the reader's place and an open aside", async ({ page }) => {
  await open(page);
  // The browser's own scroll anchoring is switched off, so this is the component keeping the place.
  await page.addStyleTag({ content: "html, body, article, ob-reading-modes { overflow-anchor: none !important; }" });
  await page.getByText("An aside", { exact: true }).click();
  await expect(page.locator("details", { hasText: "An aside" })).toHaveJSProperty("open", true);
  const filler = page.getByText("Filler paragraph 5 keeps", { exact: false });
  const place = () => filler.evaluate((node) => Math.round(node.getBoundingClientRect().top));
  await filler.scrollIntoViewIfNeeded();
  await page.evaluate(() => window.scrollBy(0, 120));
  const before = await place();
  expect(before).toBeGreaterThan(0);
  for (const mode of ["guided", "deep-dive", "standard"]) {
    // A choice made without moving the page, as a keyboard choice from the top would be.
    await page.evaluate((value) => document.querySelector(`input[value="${value}"]`).click(), mode);
    await expect(page.locator(`input[value="${mode}"]`)).toBeChecked();
    expect(Math.abs((await place()) - before), mode).toBeLessThanOrEqual(1);
    await expect(page.locator("details", { hasText: "An aside" })).toHaveJSProperty("open", true);
  }
});

test("labels stay on every shown supplement and a layer that cannot be read is never hidden", async ({ page }) => {
  await open(page);
  await radio(page, "Deep dive").check();
  for (const id of [1, 2, 3, 4]) {
    const label = page.locator(`#ob-supplement-${id}-label`);
    await expect(label).toBeVisible();
    await expect(label.locator(".ob-supplement-kind")).not.toBeEmpty();
    await expect(label.locator(".ob-supplement-level")).toContainText("supplement");
  }
  await page.evaluate(() => document.querySelector("#ob-supplement-1").setAttribute("data-ob-level", "mystery"));
  await radio(page, "Standard").check();
  await expect(supplement(page, 1)).toBeVisible();
  await expect(supplement(page, 2)).toBeHidden();
});

test("the control says what the article is, and each shown supplement has a skip link that is not part of its name", async ({ page }) => {
  await open(page);
  const note = page.locator(".ob-reading-note");
  await expect(note).toContainText("The article is the same in every mode");
  await expect(control(page)).toHaveAccessibleDescription(/everything outside those boxes is the article/);
  await radio(page, "Deep dive").check();
  // The group's name is its label alone.
  await expect(page.getByRole("group", { name: "Definition guided supplement Aporia", exact: true })).toBeVisible();
  const skip = page.getByRole("link", { name: "Skip this definition supplement" });
  await expect(skip).toHaveCount(1);
  // Seen only with focus.
  expect(await skip.evaluate((node) => node.getBoundingClientRect().width)).toBeLessThanOrEqual(1);
  await skip.focus();
  expect(await skip.evaluate((node) => node.getBoundingClientRect().width)).toBeGreaterThan(20);
  await page.keyboard.press("Enter");
  await expect(page.locator("#ob-supplement-1-end")).toBeFocused();
  expect(new URL(page.url()).hash).toBe("");
  // A supplement that is hidden has no skip link to tab to.
  await radio(page, "Standard").check();
  await expect(page.getByRole("link", { name: "Skip this definition supplement" })).toBeHidden();
});

test("no mode hides a caveat, even when the build's mark is missing, and the article's own doubt stays", async ({ page }) => {
  await open(page, "uncertain");
  await page.evaluate(() => document.querySelectorAll("[data-ob-always]").forEach((node) => node.removeAttribute("data-ob-always")));
  for (const name of ["Standard", "Guided", "Deep dive", "Standard"]) {
    await radio(page, name).check();
    await expect(page.getByText("The reading is disputed.")).toBeVisible();
    await expect(page.getByText("Why it is disputed")).toBeVisible();
    await expect(page.getByText("The witnesses disagree.")).toBeVisible();
    await expect(page.getByText("That doubt belongs to the article.")).toBeVisible();
  }
});

test("uncertainty and the author's labels remain visible wherever a supplement is shown", async ({ page }) => {
  await open(page, "uncertain");
  await radio(page, "Guided").check();
  const label = page.locator("#ob-supplement-1-label");
  await expect(label).toBeVisible();
  await expect(label.locator(".ob-supplement-kind")).toHaveText("Uncertainty");
  await expect(label.locator(".ob-supplement-level")).toContainText("guided supplement");
  await expect(label.locator(".ob-supplement-title")).toHaveText("What is not known");
  await expect(page.getByText("The dating rests on one witness.")).toBeVisible();
  // The one inside a caution is always shown and says so.
  const held = page.locator("#ob-supplement-2-label");
  await radio(page, "Standard").check();
  await expect(page.getByText("The dating rests on one witness.")).toBeHidden();
  await expect(held).toBeVisible();
  await expect(held.locator(".ob-supplement-always")).toHaveText("shown in every mode");
  await expect(page.getByText("Scholars are unsure whether the text is early.")).toBeVisible();
});

test("an open citation preview stays open and beside its marker when the mode changes, by the reader or by storage", async ({ page }) => {
  await open(page);
  await page.waitForFunction(() => customElements.get("ob-citation-previews") !== undefined);
  const marker = page.locator('[id="cite-1-ref-1"]');
  const preview = page.locator(".ob-citation-preview");
  await marker.focus();
  await expect(preview).toBeVisible();
  const text = await preview.textContent();
  const gap = async () =>
    page.evaluate(() => {
      const box = document.querySelector(".ob-citation-preview").getBoundingClientRect();
      const mark = document.getElementById("cite-1-ref-1").getBoundingClientRect();
      return Math.round(Math.abs(box.top - mark.bottom));
    });
  const before = await gap();
  // The reader's choice, made without moving focus off the marker.
  await page.evaluate(() => document.querySelector('input[value="guided"]').click());
  await expect(radio(page, "Guided")).toBeChecked();
  await expect(preview).toBeVisible();
  expect(await preview.textContent()).toBe(text);
  await expect(marker).toBeFocused();
  expect(Math.abs((await gap()) - before)).toBeLessThanOrEqual(24);
  // Another tab's choice arrives as a storage event; the supplement above the marker appears or goes.
  await page.evaluate((key) => {
    localStorage.setItem(key, "deep-dive");
    window.dispatchEvent(new StorageEvent("storage", { key, newValue: "deep-dive" }));
  }, STORAGE_KEY);
  await expect(radio(page, "Deep dive")).toBeChecked();
  await expect(preview).toBeVisible();
  expect(await preview.textContent()).toBe(text);
  await expect(marker).toBeFocused();
  expect(Math.abs((await gap()) - before)).toBeLessThanOrEqual(24);
  await page.evaluate((key) => {
    localStorage.removeItem(key);
    window.dispatchEvent(new StorageEvent("storage", { key }));
  }, STORAGE_KEY);
  await expect(radio(page, "Standard")).toBeChecked();
  await expect(preview).toBeVisible();
  expect(Math.abs((await gap()) - before)).toBeLessThanOrEqual(24);
  await page.keyboard.press("Escape");
  await expect(preview).toBeHidden();
});

test("print shows the mode on screen, without the control or skip links, with every shown supplement boxed and labelled", async ({ page }) => {
  await open(page);
  await radio(page, "Guided").check();
  await page.emulateMedia({ media: "print" });
  await expect(control(page)).toBeHidden();
  const measured = await page.evaluate(() =>
    [...document.querySelectorAll(".ob-supplement")].map((node) => {
      const style = getComputedStyle(node);
      return {
        id: node.id,
        shown: node.checkVisibility(),
        border: parseFloat(style.borderTopWidth),
        edge: parseFloat(style.borderInlineStartWidth),
        colour: style.borderTopColor,
        skip: getComputedStyle(node.querySelector(".ob-supplement-skip")).display,
        label: node.querySelector(".ob-supplement-label")?.checkVisibility() ?? false,
        end: node.querySelector(".ob-supplement-end")?.checkVisibility() ?? false,
      };
    }),
  );
  expect(measured.filter((item) => item.shown).map((item) => item.id)).toEqual(["ob-supplement-1", "ob-supplement-4"]);
  for (const item of measured.filter((entry) => entry.shown)) {
    expect(item.border, item.id).toBeGreaterThan(0);
    expect(item.edge, item.id).toBeGreaterThanOrEqual(4);
    expect(item.colour, item.id).toBe("rgb(0, 0, 0)");
    expect(item.skip, item.id).toBe("none");
    expect(item.label && item.end, item.id).toBe(true);
  }
  await expect(page.getByText("Do not heat the mixture.")).toBeVisible();
});

test("print says which supplements the printed mode left out, and nothing when none were", async ({ page }) => {
  await open(page);
  const note = page.locator(".ob-reading-print-note");
  // On screen the line is for paper only.
  await radio(page, "Guided").check();
  await expect(note).toBeHidden();
  await page.emulateMedia({ media: "print" });
  await expect(note).toBeVisible();
  await expect(note).toHaveText("Printed in Guided mode; 2 supplements not shown.");
  await page.emulateMedia({ media: "screen" });
  await radio(page, "Standard").check();
  await page.emulateMedia({ media: "print" });
  await expect(note).toHaveText("Printed in Standard mode; 3 supplements not shown.");
  await page.emulateMedia({ media: "screen" });
  await radio(page, "Deep dive").check();
  await page.emulateMedia({ media: "print" });
  await expect(note).toBeHidden();
  await expect(note).toHaveText("");
  // A layer the reader went into prints, so the count follows what is shown.
  await page.emulateMedia({ media: "screen" });
  await radio(page, "Standard").check();
  await page.evaluate(() => { location.hash = "#ob-supplement-2-h1"; });
  await expect(supplement(page, 2)).toBeVisible();
  await page.emulateMedia({ media: "print" });
  await expect(note).toHaveText("Printed in Standard mode; 2 supplements not shown.");
});

test("back and forward keep the chosen mode, one control and any supplement the reader went into", async ({ page }) => {
  await open(page);
  await radio(page, "Guided").check();
  await page.getByRole("link", { name: "the manuscripts" }).click();
  await expect(supplement(page, 2)).toBeVisible();
  await page.goBack();
  expect(new URL(page.url()).hash).toBe("");
  await expect(radio(page, "Guided")).toBeChecked();
  await expect(control(page)).toHaveCount(1);
  await expect(supplement(page, 2)).toBeVisible();
  await page.goForward();
  expect(new URL(page.url()).hash).toBe("#ob-supplement-2-h1");
  await expect(supplement(page, 2)).toBeVisible();
  await expect(page.locator("#ob-supplement-2-h1")).toBeFocused();
  // Away to another page and back: the saved choice opens the page, with no second control.
  await radio(page, "Deep dive").check();
  await page.goto(`${origin}/plain/`);
  await page.goBack();
  await expect(control(page)).toHaveCount(1);
  await expect(radio(page, "Deep dive")).toBeChecked();
  expect(await visibleSupplements(page)).toHaveLength(4);
});

test("a link to this page written in full reveals the supplement it points into", async ({ page }) => {
  await open(page);
  await page.evaluate(() => {
    const link = document.createElement("a");
    link.id = "absolute-link";
    link.href = `${location.origin}${location.pathname}#ob-supplement-2-h1`;
    link.textContent = "absolute address";
    document.querySelector("article").prepend(link);
  });
  await expect(supplement(page, 2)).toBeHidden();
  await page.locator("#absolute-link").click();
  await expect(supplement(page, 2)).toBeVisible();
  await expect(page.locator("#ob-supplement-2-h1")).toBeFocused();
  // Another page's address with the same fragment is not this page's.
  await radio(page, "Guided").check();
  await expect(supplement(page, 2)).toBeHidden();
  await page.evaluate(() => {
    const link = document.getElementById("absolute-link");
    link.href = `${location.origin}/plain/#ob-supplement-2-h1`;
    link.addEventListener("click", (event) => event.preventDefault());
  });
  await page.locator("#absolute-link").click();
  await expect(supplement(page, 2)).toBeHidden();
});

test("a link written with /index.html reveals the supplement it points into, as the page's own address does", async ({ page }) => {
  await open(page);
  // The navigation itself is not what is under test, and a reload would show the layer by itself: a listener
  // on window runs after the component's, which sees the click first, and stops the browser following it.
  await page.evaluate(() => addEventListener("click", (event) => event.preventDefault()));
  await page.evaluate(() => {
    const link = document.createElement("a");
    link.id = "index-link";
    link.href = `${location.origin}${location.pathname}index.html#ob-supplement-2-h1`;
    link.textContent = "index address";
    document.querySelector("article").prepend(link);
  });
  await expect(supplement(page, 2)).toBeHidden();
  await page.locator("#index-link").click();
  await expect(supplement(page, 2)).toBeVisible();
  await expect(page.locator("ob-reading-modes [role=status]")).toContainText("Showed the evidence supplement");
});

test("a hidden supplement nested in a shown one leaves no gap behind", async ({ page }) => {
  await open(page, "nested");
  await radio(page, "Guided").check();
  await expect(supplement(page, 1)).toBeVisible();
  await expect(supplement(page, 2)).toBeHidden();
  const measure = () =>
    page.evaluate(() => {
      const outer = document.getElementById("ob-supplement-1");
      const words = outer.querySelector("blockquote > p").getBoundingClientRect();
      const end = outer.querySelector(":scope > .ob-supplement-end").getBoundingClientRect();
      const inner = document.getElementById("ob-supplement-2");
      return { gap: end.top - words.bottom, height: outer.getBoundingClientRect().height, innerBox: inner.getBoundingClientRect().height, innerDisplay: getComputedStyle(inner).display };
    });
  const guided = await measure();
  // The hidden layer takes no box: nothing but the usual paragraph and end-line spacing is left.
  expect(guided.innerBox).toBe(0);
  expect(guided.gap).toBeLessThan(64);
  await radio(page, "Deep dive").check();
  const deep = await measure();
  expect(deep.height).toBeGreaterThan(guided.height + 20);
  // Going back removes it again, with the same height as before.
  await radio(page, "Guided").check();
  expect((await measure()).height).toBeCloseTo(guided.height, 0);
});

test("a theme from before reading modes still draws the boundary, labels and control", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await open(page, "legacy");
  await expect(page.locator('link[rel="stylesheet"][href*="legacy.css"]')).toHaveCount(1);
  await radio(page, "Deep dive").check();
  for (const id of [1, 2, 3, 4]) {
    const box = supplement(page, id);
    await expect(box).toBeVisible();
    expect(await box.evaluate((node) => parseFloat(getComputedStyle(node).borderInlineStartWidth)), String(id)).toBeGreaterThanOrEqual(4);
    await expect(page.locator(`#ob-supplement-${id}-label`)).toBeVisible();
    await expect(box.locator(":scope > .ob-supplement-end")).toBeVisible();
  }
  const overflow = await page.evaluate(() => document.querySelector("article").scrollWidth - document.querySelector("article").clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await radio(page, "Standard").check();
  expect(await visibleSupplements(page)).toEqual(["ob-supplement-4"]);
});

test("forced colours keep every box drawn", async ({ page }) => {
  await page.emulateMedia({ forcedColors: "active" });
  await open(page);
  await radio(page, "Deep dive").check();
  for (const id of [1, 2, 3, 4]) {
    const widths = await supplement(page, id).evaluate((node) => {
      const style = getComputedStyle(node);
      return [parseFloat(style.borderTopWidth), parseFloat(style.borderInlineStartWidth)];
    });
    expect(widths[0], String(id)).toBeGreaterThan(0);
    expect(widths[1], String(id)).toBeGreaterThanOrEqual(4);
  }
});

test("with the stylesheet blocked the page still names the article, every supplement and its end", async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.route(/\.css(\?.*)?$/, (route) => route.abort());
  await open(page);
  await radio(page, "Deep dive").check();
  for (const end of ["definition", "evidence", "further reading", "context"]) {
    await expect(page.getByText(`End of ${end} supplement.`, { exact: true })).toBeVisible();
  }
  await expect(page.getByRole("group", { name: /Definition guided supplement Aporia/ })).toBeVisible();
  await expect(control(page)).toContainText("everything outside those boxes is the article");
  // Landmarks: one main region holds the article, the control and every supplement; none is a landmark.
  await expect(page.getByRole("main")).toHaveCount(1);
  await expect(page.getByRole("main").getByRole("group", { name: "Reading mode", exact: true })).toBeVisible();
  await expect(page.getByRole("main").locator(".ob-supplement")).toHaveCount(4);
  await expect(page.locator(".ob-supplement[role=region], .ob-supplement[role=complementary], aside.ob-supplement")).toHaveCount(0);
  await context.close();
});

test("with reduced motion and the script blocked, nothing is pre-hidden", async ({ browser }) => {
  const context = await browser.newContext({ reducedMotion: "reduce" });
  const page = await context.newPage();
  await page.route(/\/assets\/.*\.js/, (route) => route.abort());
  await page.goto(`${origin}/modes/`);
  expect(await page.evaluate(() => customElements.get("ob-reading-modes") === undefined)).toBe(true);
  const state = await page.locator(".ob-supplement").evaluateAll((nodes) =>
    nodes.map((node) => ({
      id: node.id,
      animation: getComputedStyle(node).animationName,
      visible: getComputedStyle(node).visibility !== "hidden" && node.getBoundingClientRect().height > 0,
    })),
  );
  expect(state.map((item) => item.id)).toEqual(["ob-supplement-1", "ob-supplement-2", "ob-supplement-3", "ob-supplement-4"]);
  expect(state.every((item) => item.animation === "none" && item.visible)).toBe(true);
  await context.close();
});

test("the component ends the pre-paint hiding as its first act, and the hiding is for screens only", async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${origin}/modes/`);
  await expect(page.locator("ob-reading-modes")).toHaveClass(/ob-reading-started/);
  const rule = await page.evaluate(() =>
    [...document.styleSheets].flatMap((sheet) => [...sheet.cssRules]).filter((item) => item.cssText.includes("ob-supplement-wait")).map((item) => item.cssText),
  );
  // Only an `@media screen and (scripting: enabled)` rule starts it.
  expect(rule.some((text) => /^@media screen and \(scripting: enabled\)/.test(text))).toBe(true);
  await context.close();
});

test("at 320 CSS pixels and in the viewport 400% zoom gives, the article region has no overflow with the note and skip links", async ({ browser }) => {
  for (const viewport of [{ width: 320, height: 640 }, { width: 320, height: 256, scale: 4 }]) {
    const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, deviceScaleFactor: viewport.scale ?? 1 });
    const page = await context.newPage();
    await open(page, "uncertain");
    for (const name of ["Standard", "Guided", "Deep dive"]) {
      await radio(page, name).check();
      await page.locator(".ob-supplement-skip").first().focus();
      const measured = await page.evaluate(() => {
        const article = document.querySelector("article");
        const box = article.getBoundingClientRect();
        const wide = [...article.querySelectorAll("*")].filter((node) => node.checkVisibility() && node.getBoundingClientRect().right > box.right + 1);
        return {
          page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          article: article.scrollWidth - article.clientWidth,
          overflowing: wide.map((node) => node.tagName + "." + node.className),
        };
      });
      expect(measured.page, `${viewport.height} ${name}`).toBeLessThanOrEqual(0);
      expect(measured.article, `${viewport.height} ${name}`).toBeLessThanOrEqual(0);
      expect(measured.overflowing, `${viewport.height} ${name}`).toEqual([]);
    }
    await context.close();
  }
});
