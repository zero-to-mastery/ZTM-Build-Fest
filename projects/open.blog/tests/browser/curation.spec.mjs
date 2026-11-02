import { test, expect } from "@playwright/test";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { removeTree } from "./teardown.mjs";

// Selected for readers in the real Admin Studio (#196, ADR 0195, ADR 0196): inside the draft-side
// research panel an author selects public research context for one post, sees exactly what
// readers will get, orders it from the keyboard, withdraws it, selects it again when it went
// stale, and unselects it, without losing the draft, in Markdown or Visual mode, and the section
// reflows at 320 pixels and at 400% zoom. Nothing private, unselected or unsafe reaches the
// preview, a stale write is a conflict, and the research files are never written.

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const binary = join(repository, "target", "debug", process.platform === "win32" ? "openblog.exe" : "openblog");
const password = randomBytes(24).toString("hex");
const MODULES = ["social", "release", "field", "optimize", "accessibility", "evidence", "research", "assistant", "analytics", "contributors", "public-site"];
const LEAK = (label) => `ZqxLeak ${label} sentinel words kept private`;
const UNSAFE = "http://files.internal/ZqxLeakUrlSegmentSentinelAbcdefghijkl";
const LIBRARY = {
  version: 1,
  sources: [
    { id: "plato", kind: "work", title: "Politeia" },
    {
      id: "slings", kind: "edition", of: "plato", title: "Platonis Rempublicam",
      rights: { status: "publicDomain", note: LEAK("rightsnote") },
      notes: LEAK("librarynote"),
      identifiers: [{ scheme: "url", value: UNSAFE }, { scheme: "doi", value: "10.1000/slings" }],
    },
    { id: "bloom", kind: "translation", of: "plato", language: "en", title: "Bloom" },
    { id: "diary", kind: "work", title: LEAK("privatesource") },
  ],
};
const NOTEBOOK = {
  version: 1,
  passages: [{ id: "cave", source: "slings", excerpt: { text: "Behold the den" }, locators: [{ kind: "page", value: "514" }] }],
  notes: [{ id: "worry", kind: "question", text: LEAK("note") }],
};
const dating = (id, year) => ({ id, aspect: "birth", date: { at: { year } }, assertedBy: { kind: "author" }, evidence: [{ source: "slings" }], visibility: "approved" });
const ATLAS = {
  version: 2,
  entries: [
    { id: "plato-person", kind: "person", label: "Plato", summary: "An Athenian philosopher.", visibility: "approved", dates: [dating("born-a", -428), dating("born-b", -424)] },
    { id: "politeia", kind: "work", label: "Politeia", source: "plato", visibility: "approved" },
    { id: "the-good", kind: "concept", label: LEAK("entrylabel"), summary: LEAK("entrysummary") },
  ],
  relationships: [
    { id: "plato-authored-politeia", kind: "authored", from: "plato-person", to: "politeia", assertedBy: { kind: "author" }, evidence: [{ source: "slings" }], uncertainty: "The dating is unsettled.", visibility: "approved" },
  ],
};
const ALIGNMENTS = {
  version: 1,
  alignments: [{ id: "cave-places", label: "The cave", visibility: "approved", members: [{ source: "slings", passage: "cave" }, { source: "bloom", absent: true }] }],
};
const BODY = "## Abstract\n\nThe cave educates [@slings, page 514].\n\n## References\n";
const POST = `---\ntitle: Cave\ndate: 2026-10-01\nprofile: research\ncitations: notes\n---\n\n${BODY}`;
let root;
let server;
let origin;

const research = (name) => join(root, ".openblog", "private", "research", name);
const FILES = ["sources.json", "notebook.json", "atlas.json", "alignments.json"];
const researchBytes = () => FILES.map((name) => readFileSync(research(name), "utf8"));
const selectionsPath = () => research("selections.json");
const post = (name) => join(root, "content", "posts", name);
const usePreset = (preset, editorMode) => {
  const file = join(root, ".openblog", "private", "admin-preferences", `${createHash("sha256").update("writer").digest("hex")}.json`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ schemaVersion: 1, preset, density: "comfortable", editorMode, moduleOrder: MODULES, hiddenModules: [] }));
};
const reset = () => {
  writeFileSync(research("sources.json"), JSON.stringify(LIBRARY));
  writeFileSync(research("notebook.json"), JSON.stringify(NOTEBOOK));
  writeFileSync(research("atlas.json"), JSON.stringify(ATLAS));
  writeFileSync(research("alignments.json"), JSON.stringify(ALIGNMENTS));
  rmSync(selectionsPath(), { force: true });
  writeFileSync(post("cave.md"), POST);
  rmSync(post("wip.md"), { force: true });
};

test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "openblog-curation-"));
  cpSync(join(repository, "examples", "portable-publishing"), root, { recursive: true });
  mkdirSync(dirname(research("sources.json")), { recursive: true });
  reset();
  const config = JSON.parse(readFileSync(join(root, "openblog.json"), "utf8"));
  config.knowledgeAtlas = { publish: true };
  config.comparisons = { publish: true };
  config.curatedContext = { publish: true };
  writeFileSync(join(root, "openblog.json"), JSON.stringify(config, null, 2));
  execFileSync(binary, ["user", "add", "writer", "--root", root], { env: { ...process.env, OPENBLOG_PASSWORD: password }, stdio: "pipe" });
  const listener = createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const port = listener.address().port;
  await new Promise((done) => listener.close(done));
  origin = `http://127.0.0.1:${port}`;
  server = spawn(binary, ["serve", "--admin", "--root", root, "--port", String(port)], { cwd: repository, stdio: "pipe" });
  let output = "";
  server.stdout.on("data", (data) => { output += data; });
  server.stderr.on("data", (data) => { output += data; });
  await expect(async () => {
    if (server.exitCode !== null) throw new Error(`Test server exited: ${output}`);
    expect((await fetch(`${origin}/admin/`)).ok).toBe(true);
  }).toPass({ timeout: 30000 });
});

test.afterAll(async () => {
  if (server && server.exitCode === null) {
    const stopped = once(server, "exit");
    server.kill();
    await stopped;
  }
  // Windows can hold the stopped server's files for a moment.
  removeTree(root);
});

let dialogs;
test.beforeEach(({ page }) => {
  usePreset("simple", "markdown");
  reset();
  dialogs = [];
  page.on("dialog", async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.accept();
  });
});

async function signIn(page) {
  await page.goto(`${origin}/admin/`);
  const username = page.getByLabel("Username", { exact: true });
  if (await username.waitFor({ state: "visible", timeout: 5000 }).then(() => true, () => false)) {
    await username.fill("writer");
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.locator('[data-action="logout"]')).toBeVisible();
  }
}

async function openCave(page) {
  await signIn(page);
  await page.goto(`${origin}/admin/#/edit/posts%2Fcave.md`);
  await expect(page.getByRole("textbox", { name: "Title", exact: true })).toHaveValue("Cave");
  await page.getByRole("button", { name: "Research", exact: true }).click();
  await expect(panel(page)).toBeVisible();
  await expect(curation(page).getByRole("heading", { level: 4, name: "Selected for readers" })).toBeVisible();
  await expect(curation(page).locator("[data-curation-status]")).toContainText(/selections? for this post/);
}

const panel = (page) => page.getByRole("complementary", { name: "Research" });
const curation = (page) => panel(page).locator("[data-curation]");
const sourceItem = (page, key) => panel(page).locator(`[data-draft-item="${key}"]`);
const given = (page) => curation(page).locator('[data-curation-given="true"] > li');
const held = (page) => curation(page).locator('[data-curation-held="true"] > li');
const row = (page, id) => curation(page).locator(`[data-curation-item="${id}"]`);
const status = (page) => curation(page).locator("[data-curation-status='true']");
const markdown = (page) => page.getByRole("textbox", { name: "Markdown", exact: true });

/** The author's view as the server sends it: what readers get is its `preview`. */
const view = async (page, post = "cave") => {
  const response = await page.request.get(`${origin}/admin/api/research/curation?post=${post}`);
  expect(response.status()).toBe(200);
  return { text: await response.text(), json: await response.json() };
};

/** Elements of `region` whose box ends right of it, or a region that scrolls sideways, by name. */
const overflowing = (region) =>
  region.evaluate((element) => {
    const edge = element.getBoundingClientRect().right;
    const clipped = (node) => {
      for (let parent = node.parentElement; parent && parent !== element; parent = parent.parentElement) {
        if (["auto", "scroll", "hidden", "clip"].includes(getComputedStyle(parent).overflowX)) return true;
      }
      return false;
    };
    return [...element.querySelectorAll("*")]
      .filter((node) => node.getClientRects().length && node.getBoundingClientRect().right > edge + 1 && !clipped(node))
      .map((node) => `${node.tagName.toLowerCase()}.${[...node.classList].join(".")}${node.id ? `#${node.id}` : ""}`)
      .concat(element.getBoundingClientRect().right > window.innerWidth + 1 ? ["the region is wider than the window"] : [])
      .concat(document.documentElement.scrollWidth - window.innerWidth > 1 ? ["the page scrolls sideways"] : []);
  });

async function selectSourceReference(page) {
  await sourceItem(page, "source:slings").click();
  await panel(page).getByRole("button", { name: "Select as a reference for readers" }).click();
  const form = curation(page).locator("form.oba-curation-new");
  await expect(form.getByRole("heading", { name: "Select for readers: Platonis Rempublicam" })).toBeFocused();
  await form.getByLabel("Public identifiers").check();
  await form.getByLabel("Imported from", { exact: true }).check();
  await form.getByLabel("Where it was imported from").fill("CSL JSON import");
  await form.getByRole("button", { name: "Select for readers" }).click();
  await expect(given(page)).toHaveCount(1);
}

async function selectEntry(page) {
  await sourceItem(page, "atlas:plato-person").click();
  await panel(page).getByRole("button", { name: "Select this entry for readers" }).click();
  const form = curation(page).locator("form.oba-curation-new");
  await form.getByLabel("Summary").check();
  await form.getByRole("button", { name: "Select for readers" }).click();
}

test("an author selects, sees exactly what readers get, orders from the keyboard, withdraws, selects again and unselects, keeping the draft", async ({ page }) => {
  await openCave(page);
  const before = researchBytes();
  // Unsaved words in the draft must survive every step.
  await markdown(page).fill(`${BODY}\nUNSAVED-MARKER words not yet saved.\n`);

  await selectSourceReference(page);
  await expect(status(page)).toContainText("Selected Source reference: Platonis Rempublicam for readers");
  await selectEntry(page);
  await expect(given(page)).toHaveCount(2);
  // The relationship comes from the entry's own detail.
  await sourceItem(page, "atlas:plato-person").click();
  await panel(page).getByRole("button", { name: /^Select the relationship/ }).click();
  await curation(page).locator("form.oba-curation-new").getByRole("button", { name: "Select for readers" }).click();
  await expect(given(page)).toHaveCount(3);

  // What readers get: the preview rows, and the exact public data beside them.
  const preview = curation(page).locator("[data-curation-preview]");
  await expect(preview.locator("li[data-curation-previewed]")).toHaveCount(3);
  await expect(preview).toContainText("Platonis Rempublicam");
  await expect(preview).toContainText("An Athenian philosopher.");
  await expect(preview).toContainText("the site author");
  await expect(preview).toContainText("The dating is unsettled.");
  // The imported origin is stated as given; the unsafe address and the private fields are absent.
  await expect(preview).toContainText("imported from CSL JSON import");
  await expect(preview).not.toContainText("files.internal");
  await expect(preview).not.toContainText("ZqxLeak");
  await expect(preview).toContainText("10.1000/slings");
  const exact = await preview.locator("details pre").allTextContents();
  const served = await view(page);
  expect(exact).toEqual(served.json.preview.items.map((item) => JSON.stringify(item, null, 2)));

  // Order from the keyboard: the relationship is last, so move it up twice.
  const relationship = given(page).last();
  const id = await relationship.getAttribute("data-curation-item");
  const up = relationship.getByRole("button", { name: /^Move .* up$/ });
  await up.focus();
  await page.keyboard.press("Enter");
  await expect(status(page)).toContainText("is now 2 of 3.");
  await expect(row(page, id).getByRole("button", { name: /^Move .* up$/ })).toBeFocused();
  await page.keyboard.press("Space");
  await expect(status(page)).toContainText("is now 1 of 3.");
  await expect(given(page).first()).toHaveAttribute("data-curation-item", id);
  // The order is the author's, saved: a fresh read gives it back.
  expect((await view(page)).json.preview.items[0].id).toBe(id);
  await expect(row(page, id).getByRole("button", { name: /^Move .* up$/ })).toBeDisabled();

  // Withdraw with a reason, from the keyboard; Escape backs out without sending anything.
  const entryId = await given(page).filter({ hasText: "Atlas entry: Plato" }).getAttribute("data-curation-item");
  await row(page, entryId).getByRole("button", { name: /^Withdraw/ }).click();
  const reason = row(page, entryId).getByLabel(/^Why withdraw/);
  await expect(reason).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(row(page, entryId).getByRole("button", { name: /^Withdraw/ })).toBeFocused();
  await expect(reason).toHaveCount(0);
  await row(page, entryId).getByRole("button", { name: /^Withdraw/ }).click();
  await reason.fill("rethinking the summary");
  await page.keyboard.press("Enter");
  await expect(given(page)).toHaveCount(2);
  await expect(held(page)).toHaveCount(1);
  await expect(row(page, entryId)).toContainText("Withdrawn by you");
  await expect(row(page, entryId)).toContainText("rethinking the summary");
  await expect(row(page, entryId).getByRole("button", { name: /^Select .* again$/ })).toBeFocused();
  expect(JSON.parse(readFileSync(selectionsPath(), "utf8")).selections.find((s) => s.id === entryId).state).toBe("withdrawn");
  // Select again makes it live again against what it is now.
  await page.keyboard.press("Enter");
  await expect(given(page)).toHaveCount(3);
  await expect(held(page)).toHaveCount(0);

  // Unselect asks first and says the research is untouched.
  await row(page, entryId).getByRole("button", { name: /^Unselect/ }).click();
  await expect(row(page, entryId)).toContainText("The research it selects is not changed.");
  await row(page, entryId).getByRole("button", { name: "Keep it" }).click();
  await expect(row(page, entryId).getByRole("button", { name: /^Unselect/ })).toBeFocused();
  await row(page, entryId).getByRole("button", { name: /^Unselect/ }).click();
  await row(page, entryId).getByRole("button", { name: "Unselect", exact: true }).click();
  await expect(given(page)).toHaveCount(2);
  await expect(curation(page).getByRole("heading", { level: 5, name: /^Given to readers/ })).toBeFocused();

  // Nothing was lost or written beyond the selections file.
  await expect(markdown(page)).toHaveValue(`${BODY}\nUNSAVED-MARKER words not yet saved.\n`);
  expect(readFileSync(post("cave.md"), "utf8")).toBe(POST);
  expect(researchBytes()).toEqual(before);
  expect(dialogs).toEqual([]);
});

test("a private item is never offered, the preview carries no private or unselected text, and a stale write is a conflict", async ({ page }) => {
  await openCave(page);
  // Private entries and sources have no controls and say why.
  await sourceItem(page, "atlas:the-good").click();
  await expect(panel(page).locator("[data-curation-start]")).toHaveCount(0);
  await sourceItem(page, "source:diary").click();
  await expect(panel(page).locator("[data-curation-start]")).toHaveCount(0);
  await expect(panel(page).locator("[data-draft-research-curate]")).toContainText("Selecting never approves it.");
  // The server refuses it too, naming the rule, and writes nothing.
  const current = await view(page);
  expect(existsSync(selectionsPath())).toBe(false);
  const csrf = await page.evaluate(async () => (await (await fetch("/admin/api/session")).json()).csrf);
  const refused = await page.request.post(`${origin}/admin/api/research/curation/selections`, {
    headers: { "X-CSRF-Token": csrf, "Content-Type": "application/json" },
    data: { revision: current.json.revision, post: "cave", selection: { kind: "reference", target: "diary" } },
  });
  expect(refused.status()).toBe(422);
  expect((await refused.json()).error).toContain("stays private");
  expect(existsSync(selectionsPath())).toBe(false);

  await selectSourceReference(page);
  const served = await view(page);
  for (const label of ["rightsnote", "librarynote", "privatesource", "note", "entrylabel", "entrysummary"]) {
    expect(served.text, label).not.toContain(LEAK(label));
  }
  expect(JSON.stringify(served.json.preview)).not.toContain("files.internal");
  expect(JSON.stringify(served.json.preview)).not.toContain("rights");
  // The identifiers the author did not list stay out; the reference lists only what was chosen.
  const reference = served.json.preview.items[0];
  expect(Object.keys(reference.content).sort()).toEqual(["creators", "identifiers", "key", "kind", "title"].filter((key) => key in reference.content));
  expect(JSON.stringify(reference.content)).toContain("10.1000/slings");

  // A change made elsewhere is a conflict that reloads and changes nothing.
  const theirs = JSON.parse(readFileSync(selectionsPath(), "utf8"));
  theirs.selections[0].withdrawnReason = undefined;
  writeFileSync(selectionsPath(), JSON.stringify({ ...theirs, futureKey: 1 }, null, 2));
  const bytes = readFileSync(selectionsPath(), "utf8");
  await row(page, theirs.selections[0].id).getByRole("button", { name: /^Withdraw/ }).click();
  await row(page, theirs.selections[0].id).getByRole("button", { name: "Withdraw", exact: true }).click();
  await expect(curation(page).locator("[data-curation-error]")).toContainText("changed elsewhere since you read them");
  await expect(curation(page).locator("[data-curation-error]")).toBeFocused();
  expect(readFileSync(selectionsPath(), "utf8")).toBe(bytes);
});

test("a selection goes stale when the research changes, stays withheld, and cannot be ordered until it is selected again", async ({ page }) => {
  await openCave(page);
  await selectEntry(page);
  await expect(given(page)).toHaveCount(1);
  const id = await given(page).first().getAttribute("data-curation-item");
  const atlas = JSON.parse(readFileSync(research("atlas.json"), "utf8"));
  atlas.entries[0].summary = "A different summary, written later.";
  writeFileSync(research("atlas.json"), JSON.stringify(atlas));
  await panel(page).getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(held(page)).toHaveCount(1);
  await expect(row(page, id)).toContainText("changed after you selected it");
  await expect(row(page, id).getByRole("button", { name: /^Withdraw/ })).toHaveCount(0);
  await expect(curation(page).locator(".oba-curation-preview")).not.toContainText("A different summary");
  await row(page, id).getByRole("button", { name: /^Select .* again$/ }).click();
  await expect(given(page)).toHaveCount(1);
  await expect(curation(page).locator(".oba-curation-preview")).toContainText("A different summary, written later.");
});

test("the post's What it makes public lists the curated report with the caveat on a dating with an unselected rival", async ({ page }) => {
  await openCave(page);
  await sourceItem(page, "atlas:plato-person").click();
  await panel(page).getByRole("button", { name: /^Select the dating/ }).first().click();
  await curation(page).locator("form.oba-curation-new").getByRole("button", { name: "Select for readers" }).click();
  await expect(given(page)).toHaveCount(1);
  await expect(given(page).first()).toContainText("competing unselected");
  await page.goto(`${origin}/admin/#/edit/posts%2Fcave.md?pane=evidence`);
  await page.getByRole("button", { name: "What this post makes public", exact: true }).click();
  const boundary = page.locator('[data-boundary-preview="post"]');
  await expect(boundary.locator('[data-boundary-projection="curated"]')).toBeVisible();
  await expect(boundary.locator("[data-boundary-notice='competing-unselected']")).toContainText("born-b");
  // The build prints it as a boundary warning and carries none of the text.
  const built = spawnSync(binary, ["build", "--root", root, "--out", join(root, "dist-curation")], { encoding: "utf8" });
  expect(built.status).toBe(0);
  expect(`${built.stdout}${built.stderr}`).toMatch(/boundary: .*not selected: born-b/);
  rmSync(join(root, "dist-curation"), { recursive: true, force: true });
});

test("selecting works in Markdown and Visual modes without changing the draft", async ({ page }) => {
  await openCave(page);
  await markdown(page).fill(`${BODY}\nMODE-MARKER words.\n`);
  await page.getByRole("button", { name: "Visual", exact: true }).click();
  const visual = page.getByRole("textbox", { name: "Visual editor" });
  await expect(visual).toContainText("MODE-MARKER words.");
  await selectEntry(page);
  await expect(given(page)).toHaveCount(1);
  await expect(visual).toContainText("MODE-MARKER words.");
  await page.getByRole("button", { name: "Markdown", exact: true }).click();
  await expect(markdown(page)).toHaveValue(/MODE-MARKER words\./);
  await sourceItem(page, "comparison:cave-places").click();
  await panel(page).getByRole("button", { name: "Select this comparison for readers" }).click();
  await curation(page).locator("form.oba-curation-new").getByRole("button", { name: "Select for readers" }).click();
  await expect(given(page)).toHaveCount(2);
  await expect(markdown(page)).toHaveValue(/MODE-MARKER words\./);
  expect(readFileSync(post("cave.md"), "utf8")).toBe(POST);
});

for (const [name, setup] of [
  ["320 pixels", async (page) => page.setViewportSize({ width: 320, height: 720 })],
  // A browser at 400% zoom lays the page out at a quarter of its window's width, at four device pixels per CSS pixel.
  ["400% zoom of a 1280 pixel window", async (page) => {
    const client = await page.context().newCDPSession(page);
    await client.send("Emulation.setDeviceMetricsOverride", { width: 320, height: 225, deviceScaleFactor: 4, mobile: false });
  }],
]) {
  test(`the section reflows at ${name} without sideways scrolling`, async ({ page }) => {
    await setup(page);
    await openCave(page);
    await setup(page);
    await selectSourceReference(page);
    await selectEntry(page);
    // The change arrives with the rebuilt site: wait for it before touching the list.
    await expect(given(page)).toHaveCount(2);
    await row(page, (await given(page).first().getAttribute("data-curation-item"))).getByRole("button", { name: /^Withdraw/ }).click();
    await expect(curation(page).locator("[data-curation-preview] li").first()).toBeVisible();
    for (const details of await curation(page).locator("details.oba-curation-exact").all()) await details.locator("summary").click();
    expect(await overflowing(curation(page))).toEqual([]);
    expect(await overflowing(panel(page))).toEqual([]);
    // The controls stay reachable: each button is at least as wide as a touch target.
    for (const button of await curation(page).getByRole("button").all()) {
      if (!(await button.isVisible())) continue;
      const box = await button.boundingBox();
      expect(box.width, await button.innerText()).toBeGreaterThan(24);
    }
  });
}

// ---------------------------------------------------------------- review fixes for #196

const WIP = "---\ntitle: Wip\ndate: 2026-10-02\nprofile: research\ncitations: notes\ndraft: true\n---\n\n## Abstract\n\nAn unfinished thought [@slings, page 514].\n\n## References\n";

async function openPost(page, slug, title) {
  await signIn(page);
  await page.goto(`${origin}/admin/#/edit/posts%2F${slug}.md`);
  await expect(page.getByRole("textbox", { name: "Title", exact: true })).toHaveValue(title);
  await page.getByRole("button", { name: "Research", exact: true }).click();
  await expect(panel(page)).toBeVisible();
  await expect(curation(page).locator("[data-curation-status]")).toContainText(/selections? for this post/);
}

test("a draft previews and orders its own selections as they will be when it is published, while the build publishes none of them", async ({ page }) => {
  writeFileSync(post("wip.md"), WIP);
  try {
    await openPost(page, "wip", "Wip");
    await expect(curation(page).locator("[data-curation-when-published]")).toContainText("This post is not published yet");
    await selectEntry(page);
    await expect(given(page)).toHaveCount(1);
    await sourceItem(page, "comparison:cave-places").click();
    await panel(page).getByRole("button", { name: "Select this comparison for readers" }).click();
    await curation(page).locator("form.oba-curation-new").getByRole("button", { name: "Select for readers" }).click();
    await expect(given(page)).toHaveCount(2);
    await expect(curation(page).getByRole("heading", { level: 5, name: "What readers of this post get when this post is published" })).toBeVisible();
    await expect(curation(page).locator("[data-curation-preview] li[data-curation-previewed]")).toHaveCount(2);
    await expect(given(page).first()).toContainText("Published with this post");
    // Ordering works there, from the keyboard.
    const first = await given(page).first().getAttribute("data-curation-item");
    const down = given(page).first().getByRole("button", { name: /^Move .* down$/ });
    await down.focus();
    await page.keyboard.press("Enter");
    await expect(status(page)).toContainText("is now 2 of 2.");
    await expect(given(page).last()).toHaveAttribute("data-curation-item", first);
    const served = await view(page, "wip");
    expect(served.json.whenPublished).toBe(true);
    expect(served.json.preview.items.at(-1).id).toBe(first);
    // The build's rule is unchanged: a post that is not published is given nothing.
    const out = join(root, "dist-wip");
    const built = spawnSync(binary, ["build", "--root", root, "--out", out], { encoding: "utf8" });
    expect(built.status).toBe(0);
    const stored = JSON.parse(readFileSync(selectionsPath(), "utf8"));
    expect(stored.selections.find((s) => s.id === first).positions).toEqual({ wip: 2 });
    rmSync(out, { recursive: true, force: true });
    // A published post is not labelled so.
    await page.goto(`${origin}/admin/#/edit/posts%2Fcave.md`);
    await expect(page.getByRole("textbox", { name: "Title", exact: true })).toHaveValue("Cave");
    await expect(curation(page).locator("[data-curation-when-published]")).toHaveCount(0);
  } finally {
    rmSync(post("wip.md"), { force: true });
  }
});

test("a conflict keeps the half-filled form: the comment, who it is by and where it applies", async ({ page }) => {
  await openCave(page);
  await sourceItem(page, "source:slings").click();
  await panel(page).getByRole("button", { name: "Add my comment on this source for readers" }).click();
  const form = curation(page).locator("form.oba-curation-new");
  await form.getByLabel("Your words").fill("A careful comment I would hate to retype.");
  await form.getByLabel("Who the words are attributed to").fill("The author");
  await form.getByLabel("Where in the source it applies (optional)").fill("514a");
  // Someone else changes the selections first.
  const csrf = await page.evaluate(async () => (await (await fetch("/admin/api/session")).json()).csrf);
  const current = await view(page);
  const theirs = await page.request.post(`${origin}/admin/api/research/curation/selections`, {
    headers: { "X-CSRF-Token": csrf, "Content-Type": "application/json" },
    data: { revision: current.json.revision, post: "cave", selection: { kind: "contextual-entry", target: "politeia", posts: ["cave"] } },
  });
  expect(theirs.status()).toBe(201);
  await form.getByRole("button", { name: "Select for readers" }).click();
  await expect(curation(page).locator("[data-curation-error]")).toContainText("changed elsewhere since you read them");
  // The list and the preview are the newer ones, and the form still holds every value.
  await expect(given(page)).toHaveCount(1);
  await expect(curation(page).locator("[data-curation-preview] li[data-curation-previewed]")).toHaveCount(1);
  await expect(form.getByLabel("Your words")).toHaveValue("A careful comment I would hate to retype.");
  await expect(form.getByLabel("Who the words are attributed to")).toHaveValue("The author");
  await expect(form.getByLabel("Where in the source it applies (optional)")).toHaveValue("514a");
  // Choosing again, now against the newer revision, saves it as typed.
  await form.getByRole("button", { name: "Select for readers" }).click();
  await expect(given(page)).toHaveCount(2);
  const stored = JSON.parse(readFileSync(selectionsPath(), "utf8"));
  expect(stored.selections.some((s) => s.text === "A careful comment I would hate to retype." && s.by === "The author" && s.locator === "514a")).toBe(true);
});

test("Escape closes the unselect confirmation or the new-selection form and leaves the research panel open", async ({ page }) => {
  await openCave(page);
  await selectEntry(page);
  await expect(given(page)).toHaveCount(1);
  const id = await given(page).first().getAttribute("data-curation-item");
  await row(page, id).getByRole("button", { name: /^Unselect/ }).click();
  await expect(row(page, id)).toContainText("The research it selects is not changed.");
  await row(page, id).getByRole("button", { name: "Unselect", exact: true }).focus();
  await page.keyboard.press("Escape");
  await expect(row(page, id)).not.toContainText("The research it selects is not changed.");
  await expect(panel(page)).toBeVisible();
  await expect(row(page, id).getByRole("button", { name: /^Unselect/ })).toBeFocused();
  // The new-selection form.
  await sourceItem(page, "comparison:cave-places").click();
  await panel(page).getByRole("button", { name: "Select this comparison for readers" }).click();
  const form = curation(page).locator("form.oba-curation-new");
  await expect(form).toBeVisible();
  await expect(form.getByRole("heading", { name: /^Select for readers/ })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(form).toHaveCount(0);
  await expect(panel(page)).toBeVisible();
  await expect(given(page)).toHaveCount(1);
});

test("an open item shows the selection made from it without reopening it", async ({ page }) => {
  await openCave(page);
  await sourceItem(page, "atlas:plato-person").click();
  await expect(panel(page).locator("[data-draft-research-selected]")).toHaveCount(0);
  await panel(page).getByRole("button", { name: "Select this entry for readers" }).click();
  await curation(page).locator("form.oba-curation-new").getByRole("button", { name: "Select for readers" }).click();
  await expect(given(page)).toHaveCount(1);
  await expect(panel(page).locator("[data-draft-research-selected]")).toContainText("Atlas entry: Plato");
});
