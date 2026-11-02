import { test, expect } from "@playwright/test";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { removeTree } from "./teardown.mjs";

// The research workspace in the real Admin Studio (A8.1, ADR 0120 and ADR 0121): landmarks, the
// skip link and focus on route change; the earlier research routes redirecting; keyboard-only
// movement between panels; private research and the publishable draft told apart for screen
// readers; unsaved source and draft edits kept while switching panels, asked about before they
// are lost, and guarded on reload; the empty workspace leading from a first source to a cited
// draft; presets placing the workspace; and no horizontal overflow at 320 pixels.

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const binary = join(repository, "target", "debug", process.platform === "win32" ? "openblog.exe" : "openblog");
const password = randomBytes(24).toString("hex");
const MODULES = ["social", "release", "field", "optimize", "accessibility", "evidence", "research", "assistant", "analytics", "contributors", "public-site"];
const LIBRARY = { version: 1, sources: [{ id: "plato-republic", kind: "work", title: "Πολιτεία" }] };
const NOTEBOOK = {
  version: 1,
  passages: [{ id: "cave", source: "plato-republic", excerpt: { text: "Behold! human beings living in an underground den", language: "en" }, locators: [{ kind: "canonical", value: "514a" }] }],
  notes: [],
};
let root;
let server;
let origin;

const research = (name) => join(root, ".openblog", "private", "research", name);
const writeResearch = ({ library = LIBRARY, notebook = NOTEBOOK } = {}) => {
  mkdirSync(dirname(research("sources.json")), { recursive: true });
  rmSync(research("sources.json"), { force: true });
  rmSync(research("notebook.json"), { force: true });
  if (library) writeFileSync(research("sources.json"), JSON.stringify(library));
  if (notebook) writeFileSync(research("notebook.json"), JSON.stringify(notebook));
};
const storedLibrary = () => readFileSync(research("sources.json"), "utf8");
// Workspace preferences are private per login; the file is written as Personalize would save it.
const usePreset = (preset, editorMode = "markdown") => {
  const file = join(root, ".openblog", "private", "admin-preferences", `${createHash("sha256").update("writer").digest("hex")}.json`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ schemaVersion: 1, preset, density: "comfortable", editorMode, moduleOrder: MODULES, hiddenModules: [] }));
};

test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "openblog-research-workspace-"));
  cpSync(join(repository, "examples", "portable-publishing"), root, { recursive: true });
  writeResearch();
  execFileSync(binary, ["user", "add", "writer", "--root", root], {
    env: { ...process.env, OPENBLOG_PASSWORD: password }, stdio: "pipe",
  });
  // A second account, for kept panels that must never reach anyone but the writer.
  execFileSync(binary, ["user", "add", "editor", "--root", root], {
    env: { ...process.env, OPENBLOG_PASSWORD: password }, stdio: "pipe",
  });
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
  writeResearch();
  usePreset("simple");
  dialogs = [];
  // Every dialog is recorded; a test that expects none checks the list. Confirms are answered
  // with the next queued answer (accept by default).
  page.on("dialog", async (dialog) => {
    dialogs.push({ type: dialog.type(), message: dialog.message() });
    const answer = dialogs.answers?.length ? dialogs.answers.shift() : true;
    if (answer) await dialog.accept();
    else await dialog.dismiss();
  });
});

async function openAdmin(page, hash) {
  await page.goto(`${origin}/admin/`);
  const username = page.getByLabel("Username", { exact: true });
  if (await username.waitFor({ state: "visible", timeout: 5000 }).then(() => true, () => false)) {
    await username.fill("writer");
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.locator('[data-action="logout"]')).toBeVisible();
  }
  await page.goto(`${origin}/admin/${hash}`);
}

const workspaceNav = (page) => page.getByRole("navigation", { name: "Research workspace" });
const panelLink = (page, name) => workspaceNav(page).getByRole("link", { name, exact: true });
const pageHeading = (page) => page.locator("#oba-page-heading");
const markdown = (page) => page.getByRole("textbox", { name: "Markdown", exact: true });
const title = (page) => page.getByRole("textbox", { name: "Title", exact: true });

/** The page's horizontal overflow, with the elements that cause it named for the failure message. */
async function overflow(page) {
  return page.evaluate(() => {
    const width = window.innerWidth;
    const clipped = (element) => {
      for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent);
        if (["auto", "scroll", "hidden", "clip"].includes(style.overflowX)) return true;
      }
      return false;
    };
    const offenders = [...document.querySelectorAll("body *")]
      .filter((element) => element.getClientRects().length && element.getBoundingClientRect().right > width + 1 && !clipped(element))
      .map((element) => `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ""}.${[...element.classList].join(".")} right=${Math.round(element.getBoundingClientRect().right)}`);
    return { scroll: document.documentElement.scrollWidth - width, offenders };
  });
}

test("landmarks, a skip link, and one page heading frame every research panel", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openAdmin(page, "#/research/overview");
  await expect(pageHeading(page)).toHaveText("Research workspace");
  await expect(page.getByRole("banner")).toHaveCount(1);
  await expect(page.getByRole("main")).toHaveCount(1);
  await expect(page.getByRole("navigation", { name: "Admin tools" })).toBeVisible();
  await expect(workspaceNav(page)).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
  await expect(page.getByRole("heading", { level: 2, name: "From source to draft" })).toBeVisible();

  // From a fresh load, the first Tab reaches the skip link.
  await page.reload();
  await expect(pageHeading(page)).toHaveText("Research workspace");
  await page.keyboard.press("Tab");
  const skip = page.getByRole("link", { name: "Skip to main content" });
  await expect(skip).toBeFocused();
  await expect(skip).toBeInViewport();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("main")).toBeFocused();
  expect(new URL(page.url()).hash).toBe("#/research/overview");
});

test("the earlier research addresses redirect into the workspace and open the same thing", async ({ page }) => {
  await openAdmin(page, "#/sources");
  await expect(page).toHaveURL(/#\/research\/sources$/);
  await expect(pageHeading(page)).toHaveText("Sources");
  await expect(panelLink(page, "Sources")).toHaveAttribute("aria-current", "page");
  await page.goto(`${origin}/admin/#/research`);
  await expect(page).toHaveURL(/#\/research\/notebook$/);
  await expect(page.locator("#oba-research-search")).toBeVisible();
  await page.goto(`${origin}/admin/#/atlas`);
  await expect(page).toHaveURL(/#\/research\/atlas$/);
  await expect(pageHeading(page)).toHaveText("Knowledge Atlas");
  await page.goto(`${origin}/admin/#/compare`);
  await expect(page).toHaveURL(/#\/research\/compare$/);
  await expect(pageHeading(page)).toHaveText("Compare versions");
  // A redirect replaces the address, so Back leaves the workspace instead of bouncing.
  expect(dialogs).toEqual([]);
});

test("panels are reached from the keyboard alone, and focus lands on each new page's heading", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openAdmin(page, "#/research/overview");
  await expect(pageHeading(page)).toHaveText("Research workspace");
  await panelLink(page, "Sources").focus();
  await page.keyboard.press("Enter");
  await expect(pageHeading(page)).toHaveText("Sources");
  await expect(pageHeading(page)).toBeFocused();
  await expect(panelLink(page, "Sources")).toHaveAttribute("aria-current", "page");
  // Tab from the heading reaches the workspace's own controls in order.
  await panelLink(page, "Notebook").focus();
  await page.keyboard.press("Enter");
  await expect(pageHeading(page)).toHaveText("Research notebook");
  await expect(pageHeading(page)).toBeFocused();
  await page.keyboard.press("Control+k");
  await page.keyboard.type("Knowledge Atlas");
  await page.keyboard.press("Enter");
  await expect(pageHeading(page)).toHaveText("Knowledge Atlas");
  await expect(pageHeading(page)).toBeFocused();
});

test("screen readers hear which panels are private research and which is publishable", async ({ page }) => {
  await openAdmin(page, "#/research/sources");
  const privateList = workspaceNav(page).getByRole("list", { name: "Private research" });
  const publishable = workspaceNav(page).getByRole("list", { name: "Publishable" });
  for (const name of ["Workflow", "Sources", "Notebook", "Atlas", "Compare"]) {
    await expect(privateList.getByRole("link", { name, exact: true })).toHaveAccessibleDescription("Private research");
  }
  await expect(publishable.getByRole("link", { name: "Draft", exact: true })).toHaveAccessibleDescription("Publishable No draft open: start a post");
  await expect(page.locator('[data-workspace-visibility][data-visibility="private"]')).toHaveText("Private research: nothing here is public unless you approve it for a post.");
  // The difference is not colour alone: the publishable badge has its own border style.
  const styles = await page.evaluate(() => [...document.querySelectorAll(".oba-research-nav .oba-visibility")].map((badge) => getComputedStyle(badge).borderTopStyle));
  expect(styles).toEqual(["solid", "double"]);
});

test("an unsaved source survives a switch to the notebook and back, then saves", async ({ page }) => {
  await openAdmin(page, "#/research/sources");
  await page.getByRole("button", { name: "New source" }).click();
  await page.getByLabel("ID", { exact: true }).fill("bloom-1968");
  await page.getByLabel("Title", { exact: true }).fill("The Republic of Plato");
  await panelLink(page, "Notebook").click();
  await expect(pageHeading(page)).toHaveText("Research notebook");
  const kept = workspaceNav(page).locator('[data-research-panel="sources"] .oba-research-kept');
  await expect(kept).toHaveText("Unsaved changes kept");
  await expect(panelLink(page, "Sources")).toHaveAccessibleDescription("Private research Unsaved changes kept");
  await panelLink(page, "Sources").click();
  await expect(page.getByLabel("ID", { exact: true })).toHaveValue("bloom-1968");
  await expect(page.getByLabel("Title", { exact: true })).toHaveValue("The Republic of Plato");
  await expect(page.locator("[data-workspace-status]")).toHaveText(/Sources is as you left it, with your unsaved changes\./);
  await expect(kept).toHaveCount(0);
  expect(dialogs).toEqual([]);
  expect(storedLibrary()).not.toContain("bloom-1968");
  await page.getByRole("button", { name: "Create source" }).click();
  await expect(page.getByRole("status").filter({ hasText: "The Republic of Plato saved." })).toBeVisible();
  expect(storedLibrary()).toContain("bloom-1968");
});

test("a kept notebook draft saved after the notebook changed elsewhere gets the conflict choice and keeps the draft", async ({ page }) => {
  await openAdmin(page, "#/research/notebook");
  await page.locator('[data-entry-id="cave"]').click();
  const excerpt = page.locator("#oba-research-excerpt");
  await expect(excerpt).toHaveValue("Behold! human beings living in an underground den");
  await excerpt.fill("Behold! my unsaved reading of the den");
  await panelLink(page, "Sources").click();
  await expect(pageHeading(page)).toHaveText("Sources");
  await expect(workspaceNav(page).locator('[data-research-panel="notebook"] .oba-research-kept')).toHaveText("Unsaved changes kept");

  // Someone else changes the stored passage while the notebook is kept.
  const elsewhere = structuredClone(NOTEBOOK);
  elsewhere.passages[0].excerpt.text = "Behold! the stored reading changed elsewhere";
  writeFileSync(research("notebook.json"), JSON.stringify(elsewhere));

  await panelLink(page, "Notebook").click();
  await expect(excerpt).toHaveValue("Behold! my unsaved reading of the den");
  await page.getByRole("button", { name: "Save changes" }).click();
  const conflict = page.locator("[data-capture-conflict]");
  await expect(conflict).toBeVisible();
  await expect(conflict).toContainText("changed");
  await expect(excerpt).toHaveValue("Behold! my unsaved reading of the den");
  expect(readFileSync(research("notebook.json"), "utf8")).toContain("the stored reading changed elsewhere");
  expect(readFileSync(research("notebook.json"), "utf8")).not.toContain("my unsaved reading");

  // Keeping the draft rests it on the latest notebook, and then it saves.
  await page.locator('[data-capture-conflict-use="draft"]').click();
  await expect(conflict).toHaveCount(0);
  await expect(excerpt).toHaveValue("Behold! my unsaved reading of the den");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect.poll(() => readFileSync(research("notebook.json"), "utf8")).toContain("my unsaved reading of the den");
  expect(dialogs).toEqual([]);
});

test("an address that names a source opens it in Sources", async ({ page }) => {
  await openAdmin(page, "#/research/sources/plato-republic");
  await expect(pageHeading(page)).toHaveText("Sources");
  await expect(page.getByLabel("Title", { exact: true })).toHaveValue("Πολιτεία");
  await expect(page.locator('[data-source-id="plato-republic"]')).toHaveAttribute("aria-current", "true");
  await expect(page.locator("#oba-source-heading")).toBeFocused();
  // An id the library does not have opens the panel with nothing selected.
  await page.goto(`${origin}/admin/#/research/sources/missing`);
  await expect(page.getByLabel("Title", { exact: true })).toHaveCount(0);
  expect(dialogs).toEqual([]);
});

test("an earlier address of the open panel keeps its unsaved changes", async ({ page }) => {
  await openAdmin(page, "#/research/sources");
  await page.getByRole("button", { name: "New source" }).click();
  await page.getByLabel("Title", { exact: true }).fill("Still typing");
  await page.goto(`${origin}/admin/#/sources`);
  await expect(page).toHaveURL(/#\/research\/sources$/);
  await expect(page.getByLabel("Title", { exact: true })).toHaveValue("Still typing");
  expect(dialogs).toEqual([]);
});

test("an expired session keeps unsaved panels for the same user's next sign-in", async ({ page }) => {
  await openAdmin(page, "#/research/sources");
  await page.getByRole("button", { name: "New source" }).click();
  await page.getByLabel("ID", { exact: true }).fill("kept-through-sign-in");
  await page.getByLabel("Title", { exact: true }).fill("Kept through sign-in");
  // The session ends without signing out; the next panel's request is refused.
  await page.context().clearCookies();
  await panelLink(page, "Notebook").click();
  await expect(page.getByLabel("Username", { exact: true })).toBeVisible();
  await expect(page.locator("[data-login-kept]")).toContainText("Sign in again as the same user");
  await expect(page.locator("form")).not.toContainText("Kept through sign-in");

  await page.getByLabel("Username", { exact: true }).fill("writer");
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(pageHeading(page)).toHaveText("Research notebook");
  await expect(workspaceNav(page).locator('[data-research-panel="sources"] .oba-research-kept')).toHaveText("Unsaved changes kept");
  await panelLink(page, "Sources").click();
  await expect(page.getByLabel("Title", { exact: true })).toHaveValue("Kept through sign-in");
  await page.getByRole("button", { name: "Create source" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Kept through sign-in saved." })).toBeVisible();
  expect(storedLibrary()).toContain("kept-through-sign-in");
  expect(dialogs).toEqual([]);
});

/** Start a source in Sources and leave it unsaved by opening the notebook. */
async function keepUnsavedSource(page, label) {
  await openAdmin(page, "#/research/sources");
  await page.getByRole("button", { name: "New source" }).click();
  await page.getByLabel("ID", { exact: true }).fill("kept-private-source");
  await page.getByLabel("Title", { exact: true }).fill(label);
  await panelLink(page, "Notebook").click();
  await expect(pageHeading(page)).toHaveText("Research notebook");
  await expect(workspaceNav(page).locator('[data-research-panel="sources"] .oba-research-kept')).toHaveText("Unsaved changes kept");
}

async function signIn(page, username) {
  await page.getByLabel("Username", { exact: true }).fill(username);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.locator('[data-action="logout"]')).toBeVisible();
}

test("while signed out, a new address or Back shows the sign-in form and never a kept panel", async ({ page }) => {
  await keepUnsavedSource(page, "Private while signed out");
  await page.context().clearCookies();
  await panelLink(page, "Sources").click();
  await expect(page.getByLabel("Username", { exact: true })).toBeVisible();

  // The kept panel's address and Back both stay on the sign-in form.
  await page.evaluate(() => { location.hash = "#/research/sources"; });
  await page.evaluate(() => { location.hash = "#/research/notebook"; });
  await page.goBack();
  await page.evaluate(() => { location.hash = "#/posts"; });
  await expect(page.getByLabel("Username", { exact: true })).toBeVisible();
  await expect(page.locator('[data-action="logout"]')).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText("Private while signed out");
  await expect(page.getByLabel("Title", { exact: true })).toHaveCount(0);

  // The same writer still gets the kept panel back after signing in.
  await signIn(page, "writer");
  await panelLink(page, "Sources").click();
  await expect(page.getByLabel("Title", { exact: true })).toHaveValue("Private while signed out");
  expect(dialogs).toEqual([]);
});

test("another account signed in from a second tab never sees the writer's kept panel", async ({ page, context }) => {
  // The writer's session ends in this tab while another account signs in from a second tab on
  // the same cookie: changing this tab's address shows only the sign-in form.
  await keepUnsavedSource(page, "Writer only, ended session");
  await context.clearCookies();
  await panelLink(page, "Sources").click();
  await expect(page.getByLabel("Username", { exact: true })).toBeVisible();
  const second = await context.newPage();
  await second.goto(`${origin}/admin/#/overview`);
  await signIn(second, "editor");
  await page.evaluate(() => { location.hash = "#/research/notebook"; });
  await page.evaluate(() => { location.hash = "#/research/sources"; });
  await expect(page.getByLabel("Username", { exact: true })).toBeVisible();
  await expect(page.locator("body")).not.toContainText("Writer only, ended session");
  await second.close();
});

test("a kept panel is refused when another account replaced the session from a second tab", async ({ page, context }) => {
  // This tab still believes the writer is signed in; the second tab signs out and signs in as
  // another account. Reopening the kept panel checks the session first and shows nothing kept.
  await keepUnsavedSource(page, "Writer only, live session");
  const second = await context.newPage();
  await second.goto(`${origin}/admin/#/overview`);
  await second.locator('[data-action="logout"]').click();
  await signIn(second, "editor");
  await second.close();
  await panelLink(page, "Sources").click();
  await expect(page.getByLabel("Username", { exact: true })).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("Another account signed in on this browser");
  await expect(page.locator("body")).not.toContainText("Writer only, live session");
  await expect(page.locator("[data-login-kept]")).toHaveCount(0);
  // Signing back in as the writer finds nothing kept: the panels were discarded, never handed on.
  await signIn(page, "writer");
  await expect(page.locator("body")).not.toContainText("Writer only, live session");
  await expect(workspaceNav(page).locator(".oba-research-kept")).toHaveCount(0);
});

test("a draft keeps its unsaved title and text while research is open, and asks before it is lost", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openAdmin(page, "#/new/posts");
  await title(page).fill("On the cave");
  await markdown(page).fill("The prisoners see only shadows.");
  // Simple keeps the main navigation calm; the palette still reaches every research panel.
  await page.keyboard.press("Control+k");
  await page.keyboard.type("Sources");
  await page.keyboard.press("Enter");
  await expect(pageHeading(page)).toHaveText("Sources");
  expect(dialogs).toEqual([]);
  const draftItem = workspaceNav(page).locator('[data-research-panel="draft"]');
  await expect(draftItem).toContainText("On the cave");
  await expect(draftItem.locator(".oba-research-kept")).toHaveText("Unsaved changes kept");

  // Reloading or closing with kept work is guarded like any unsaved change.
  const guarded = await page.evaluate(() => {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(guarded).toBe(true);

  // Leaving the workspace names what would be lost; declining stays put.
  dialogs.answers = [false];
  await page.getByRole("navigation", { name: "Admin tools" }).getByRole("link", { name: "Posts", exact: true }).click();
  await expect.poll(() => dialogs.at(-1)?.message).toBe("You have unsaved changes in the draft “On the cave”. Leave without saving?");
  await expect(page).toHaveURL(/#\/research\/sources$/);

  await panelLink(page, "Draft").click();
  await expect(title(page)).toHaveValue("On the cave");
  await expect(markdown(page)).toHaveValue("The prisoners see only shadows.");
  await expect(page.locator(".oba-save-state, [class*=save-state]").first()).toHaveText(/Unsaved changes/);
  await expect(page).toHaveURL(/#\/new\/posts$/);
});

test("the claims link opens the kept draft's Evidence Studio without reloading it", async ({ page }) => {
  usePreset("guided");
  await openAdmin(page, "#/new/posts");
  await title(page).fill("Claims draft");
  await markdown(page).fill("A claim about the cave.");
  // Guided shows the workspace beside the draft, with the draft marked publishable.
  await expect(panelLink(page, "Draft")).toHaveAttribute("aria-current", "page");
  await expect(page.locator('[data-workspace-visibility][data-visibility="publishable"]')).toBeVisible();
  await panelLink(page, "Notebook").click();
  await expect(pageHeading(page)).toHaveText("Research notebook");
  await panelLink(page, "Claims").click();
  await expect(page).toHaveURL(/#\/new\/posts\?pane=evidence$/);
  await expect(page.locator('.oba-editor[data-editor-view="evidence"]')).toBeVisible();
  await expect(title(page)).toHaveValue("Claims draft");
  expect(dialogs).toEqual([]);
});

test("an empty workspace leads from a first source to a cited draft", async ({ page }) => {
  writeResearch({ library: null, notebook: null });
  await page.setViewportSize({ width: 1280, height: 900 });
  await openAdmin(page, "#/research/overview");
  await expect(page.getByRole("heading", { level: 2, name: "Start your research" })).toBeVisible();
  await expect(page.locator('[data-research-step="source"]')).toHaveAttribute("data-done", "false");
  await page.getByRole("link", { name: "Add your first source" }).click();
  await expect(pageHeading(page)).toHaveText("Sources");
  await page.getByRole("button", { name: "New source" }).click();
  await page.getByLabel("ID", { exact: true }).fill("plato-republic");
  await page.getByLabel("Title", { exact: true }).fill("Πολιτεία");
  await page.getByRole("button", { name: "Create source" }).click();
  await expect(page.getByRole("status").filter({ hasText: "saved." })).toBeVisible();

  await panelLink(page, "Workflow").click();
  await expect(page.locator('[data-research-step="source"] [data-research-step-state]')).toHaveText("Done: 1 source in the library.");
  await page.getByRole("link", { name: "Capture a passage" }).click();
  await expect(pageHeading(page)).toHaveText("Research notebook");
  await panelLink(page, "Workflow").click();
  await page.getByRole("link", { name: "Start a post" }).click();
  await expect(page).toHaveURL(/#\/new\/posts$/);
  await page.getByRole("button", { name: "Cite a source" }).click();
  await page.getByLabel("Source", { exact: true }).selectOption("plato-republic");
  await page.getByRole("button", { name: "Insert citation" }).click();
  await expect(markdown(page)).toHaveValue(/\[@plato-republic\]/);
});

test("a notebook that cannot be read is reported in its own step and changes nothing", async ({ page }) => {
  writeResearch({ notebook: null });
  writeFileSync(research("notebook.json"), "{ not json");
  await openAdmin(page, "#/research/overview");
  const step = page.locator('[data-research-step="passage"]');
  await expect(step).toHaveAttribute("data-done", "unreadable");
  await expect(step.locator("[data-research-step-state]")).toContainText("could not be read");
  await expect(step.locator("[data-research-step-state]")).toContainText("Nothing was changed.");
  await expect(page.locator('[data-research-step="source"]')).toHaveAttribute("data-done", "true");
  await expect(page.locator('[data-research-step="source"] [data-research-step-state]')).toHaveText("Done: 1 source in the library.");
  expect(readFileSync(research("notebook.json"), "utf8")).toBe("{ not json");
});

test("presets place the workspace in the main navigation and Advanced tools always reaches it", async ({ page }) => {
  await openAdmin(page, "#/overview");
  const toolbelt = page.getByRole("navigation", { name: "Admin tools" });
  await expect(toolbelt.getByRole("link", { name: "Research workspace" })).toBeHidden();
  await page.getByRole("button", { name: "Advanced tools" }).click();
  await page.getByRole("button", { name: /Research workspace/ }).click();
  await expect(pageHeading(page)).toHaveText("Research workspace");
  await expect(toolbelt.getByRole("link", { name: "Research workspace" })).toHaveAttribute("aria-current", "true");

  usePreset("guided");
  await page.goto(`${origin}/admin/#/overview`);
  await page.reload();
  await expect(pageHeading(page)).toHaveText("Overview");
  await expect(toolbelt.getByRole("link", { name: "Research workspace" })).toBeVisible();
  await expect(toolbelt.getByRole("link", { name: "Research workspace" })).not.toHaveAttribute("aria-current", /.+/);
});

test("nothing overflows a 320 pixel screen, the Admin header included", async ({ page }) => {
  usePreset("guided");
  await page.setViewportSize({ width: 320, height: 700 });
  for (const hash of ["#/research/overview", "#/research/sources", "#/research/notebook", "#/research/atlas", "#/research/compare"]) {
    await openAdmin(page, hash);
    await expect(workspaceNav(page)).toBeVisible();
    await expect(pageHeading(page)).not.toHaveText("");
    const result = await overflow(page);
    expect(result.offenders, `${hash} overflows`).toEqual([]);
    expect(result.scroll, `${hash} scrolls sideways`).toBeLessThanOrEqual(1);
  }
  await page.goto(`${origin}/admin/#/new/posts`);
  await title(page).fill("A rather long working title that has to wrap on a phone screen without overflowing");
  await panelLink(page, "Sources").click();
  await expect(workspaceNav(page).locator('[data-research-panel="draft"] .oba-research-kept')).toBeVisible();
  const kept = await overflow(page);
  expect(kept.offenders, "the kept draft's entry overflows").toEqual([]);
  expect(kept.scroll).toBeLessThanOrEqual(1);
});
