import { test, expect } from "@playwright/test";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { removeTree } from "./teardown.mjs";

// The real Admin Studio and the real claims API (core validation, revision-checked store, anchors
// checked against the saved draft) over a small library, notebook and one saved post. Covers
// keyboard-only claim and evidence authoring, UTF-8 ranges, overlapping claims, opposing links
// side by side, a stale draft that refuses new evidence, undo, and hostile source text.

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const binary = join(repository, "target", "debug", process.platform === "win32" ? "openblog.exe" : "openblog");
const password = randomBytes(24).toString("hex");
const HOSTILE = "<img src=x onerror=alert(1)>";
const DRAFT = `The cave educates the soul. ${HOSTILE} Πλάτων 🙂 says so.\n`;
const POST = "posts/2026-01-07-on-caves.md";
const LIBRARY = {
  version: 1,
  sources: [
    { id: "plato-republic", kind: "work", title: "Πολιτεία" },
    { id: "slings-2003", kind: "edition", of: "plato-republic", title: "Platonis Rempublicam" },
    { id: "scholar", kind: "work", title: `A study ${HOSTILE}` },
  ],
};
const NOTEBOOK = {
  version: 1,
  passages: [{ id: "p1", source: "slings-2003", excerpt: { text: "the cave" }, locators: [{ kind: "page", value: "514" }] }],
  notes: [],
};
let root;
let server;
let origin;

const research = (name) => join(root, ".openblog", "private", "research", name);
const postFile = () => join(root, "content", POST);
const writeFixture = (draft = DRAFT) => {
  mkdirSync(dirname(research("sources.json")), { recursive: true });
  writeFileSync(research("sources.json"), JSON.stringify(LIBRARY));
  writeFileSync(research("notebook.json"), JSON.stringify(NOTEBOOK));
  rmSync(research("claims.json"), { force: true });
  mkdirSync(dirname(postFile()), { recursive: true });
  writeFileSync(postFile(), `---\ntitle: On caves\ndate: 2026-01-07\ndraft: true\n---\n${draft}`);
};
const storedClaims = () => (existsSync(research("claims.json")) ? readFileSync(research("claims.json"), "utf8") : null);

test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "openblog-claims-"));
  cpSync(join(repository, "examples", "portable-publishing"), root, { recursive: true });
  writeFixture();
  execFileSync(binary, ["user", "add", "writer", "--root", root], {
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
  removeTree(root);
});

test.beforeEach(() => writeFixture());

async function openPost(page) {
  await page.goto(`${origin}/admin/`);
  const username = page.getByLabel("Username", { exact: true });
  if (await username.waitFor({ state: "visible", timeout: 5000 }).then(() => true, () => false)) {
    await username.fill("writer");
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.locator('[data-action="logout"]')).toBeVisible();
  }
  await page.goto(`${origin}/admin/#/edit/${encodeURIComponent(POST)}`);
  await expect(page.getByRole("button", { name: "Make a claim from the selected words" }).first()).toBeAttached();
  await page.getByRole("button", { name: "Markdown", exact: true }).click();
  await expect(markdown(page)).toBeVisible();
}

const markdown = (page) => page.getByRole("textbox", { name: "Markdown", exact: true });
const studio = (page) => page.locator("[data-claims]");
const claimHeading = (page, id) => page.locator(`#oba-claims-claim-${id}`);
// Alt+1 opens Write and Alt+9 Evidence Studio, whatever the workspace preset shows as tabs.
const showPane = (page, pane) => page.keyboard.press(pane === "evidence" ? "Alt+9" : "Alt+1");

/** Select `words` in the Markdown body, as a person would with the keyboard or mouse. */
async function select(page, words, occurrence = 0) {
  await markdown(page).evaluate((element, [text, nth]) => {
    let start = -1;
    for (let found = 0; found <= nth; found += 1) start = element.value.indexOf(text, start + 1);
    element.focus();
    element.setSelectionRange(start, start + text.length);
  }, [words, occurrence]);
}

async function makeClaim(page, words, statement) {
  await select(page, words);
  await page.getByRole("button", { name: "Make a claim from the selected words", exact: true }).first().click();
  const field = page.locator("#oba-claims-statement");
  await expect(field).toBeFocused();
  await expect(field).toHaveValue(words);
  await field.fill(statement);
  await page.locator("[data-claims-save]").focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText("Claim saved privately.")).toBeVisible();
}

test("a claim is made from selected multi-byte words and opposing evidence is linked from the keyboard", async ({ page }) => {
  await openPost(page);
  await makeClaim(page, "Πλάτων 🙂", "Plato is named.");
  const saved = JSON.parse(storedClaims());
  const body = DRAFT;
  const start = Buffer.byteLength(body.slice(0, body.indexOf("Πλάτων")), "utf8");
  expect(saved.claims[0].anchor).toEqual({ start, end: start + Buffer.byteLength("Πλάτων 🙂", "utf8"), text: "Πλάτων 🙂" });
  expect(saved.claims[0].post).toBe("on-caves");
  await expect(claimHeading(page, "plato-is-named")).toBeFocused();
  await expect(studio(page).locator('[data-claims-anchor="verified"]')).toHaveCount(1);
  // A claim with no evidence yet shows that gap and what to do, never a verdict.
  await expect(studio(page).locator('[data-claims-finding="claim-evidence-missing"]')).toContainText("Next: Link the sources you relied on");
  await expect(studio(page).locator("[data-claims-findings-summary]")).toContainText("never whether a claim is true");

  // Supporting evidence from a notebook passage, entirely from the keyboard.
  await page.getByRole("button", { name: "Link evidence to the claim: Plato is named." }).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#oba-claims-relation-supports")).toBeFocused();
  await page.keyboard.press("Space");
  await expect(page.locator("#oba-claims-relation-supports")).toBeChecked();
  await page.locator("#oba-claims-passage").selectOption("p1");
  await expect(page.locator("#oba-claims-source")).toHaveValue("slings-2003");
  await expect(page.locator("#oba-claims-locators")).toHaveValue("page: 514");
  await page.locator("#oba-claims-rationale").fill("Socrates names him.");
  await page.locator("#oba-claims-confidence").selectOption("plausible");
  await page.locator("[data-claims-save]").focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText("Evidence link saved privately.")).toBeVisible();

  // Contradicting evidence coexists, in its own column, never netted.
  await page.getByRole("button", { name: "Link evidence to the claim: Plato is named." }).click();
  await page.locator("#oba-claims-relation-contradicts").check();
  await page.locator("#oba-claims-source").selectOption("scholar");
  await page.locator("#oba-claims-uncertainty").fill("The attribution is disputed.");
  await page.locator("[data-claims-save]").click();
  await expect(page.getByText("Evidence link saved privately.")).toBeVisible();
  const columns = studio(page).locator(".oba-claim-columns");
  await expect(columns.locator('[data-claims-column="supports"]')).toContainText("Supporting (1)");
  await expect(columns.locator('[data-claims-column="contradicts"]')).toContainText("Contradicting (1)");
  await expect(columns.locator('[data-claims-column="contradicts"]')).toContainText(`A study ${HOSTILE}`);
  await expect(studio(page)).toContainText("1 supporting link, 1 contradicting link, 0 contextualizing links");
  await expect(page.locator('img[src="x"]')).toHaveCount(0);
  const links = JSON.parse(storedClaims()).links;
  expect(links.map((link) => link.relation)).toEqual(["supports", "contradicts"]);
  expect(links[0].evidence).toEqual({ source: "slings-2003", locators: [{ kind: "page", value: "514" }], passage: "p1" });

  // An overlapping claim is a separate span of the same draft, selected back in Write.
  await showPane(page, "write");
  await expect(markdown(page)).toBeVisible();
  await makeClaim(page, "Πλάτων", "Plato alone.");
  expect(JSON.parse(storedClaims()).claims).toHaveLength(2);
});

test("a stale draft refuses new evidence and leaves the claims file unchanged until re-anchored", async ({ page }) => {
  await openPost(page);
  await makeClaim(page, "educates the soul", "The cave educates.");
  // The saved draft changes elsewhere: the claim's words are gone.
  writeFileSync(postFile(), "---\ntitle: On caves\ndate: 2026-01-07\ndraft: true\n---\nA rewritten draft, with the soul trained.\n");
  const before = storedClaims();
  await openPost(page);
  await showPane(page, "evidence");
  await expect(studio(page).locator('[data-claims-anchor="stale"]')).toBeVisible();
  await expect(studio(page)).toContainText("Stale: the words are no longer in the saved draft");
  await expect(page.locator("[data-claims-add-link]")).toBeDisabled();
  expect(storedClaims()).toBe(before);

  // Re-anchor to newly selected words in the saved draft.
  await showPane(page, "write");
  await select(page, "the soul trained");
  await showPane(page, "evidence");
  await page.locator("[data-claims-reanchor]").click();
  await expect(page.getByText("Claim re-anchored to the selected words.")).toBeVisible();
  await expect(studio(page).locator('[data-claims-anchor="verified"]')).toBeVisible();
  await expect(page.locator("[data-claims-add-link]")).toBeEnabled();
  expect(JSON.parse(storedClaims()).claims[0].anchor.text).toBe("the soul trained");
});

test("words that now occur twice make a claim ambiguous, and unsaved text is never checked", async ({ page }) => {
  writeFixture("ha ha ha, the cave.\n");
  await openPost(page);
  await makeClaim(page, "the cave", "Caves again.");
  writeFileSync(postFile(), "---\ntitle: On caves\ndate: 2026-01-07\ndraft: true\n---\nthe cave and the cave.\n");
  const before = storedClaims();
  await openPost(page);
  await showPane(page, "evidence");
  await expect(studio(page).locator('[data-claims-anchor="ambiguous"]')).toBeVisible();
  await expect(page.locator("[data-claims-add-link]")).toBeDisabled();
  await expect(page.getByRole("button", { name: "Re-anchor to the selected words: Caves again." })).toBeVisible();
  expect(storedClaims()).toBe(before);

  // Typing makes the draft unsaved: nothing is checked or sent until it is saved.
  await showPane(page, "write");
  await markdown(page).press("End");
  await markdown(page).type(" More.");
  await select(page, "the cave", 1);
  await page.getByRole("button", { name: "Make a claim from the selected words", exact: true }).first().click();
  await expect(studio(page)).toContainText("Save the post first");
  expect(storedClaims()).toBe(before);
});

test("removing a link can be undone, and the studio fits a phone screen", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openPost(page);
  await makeClaim(page, "The cave", "Caves teach.");
  await page.getByRole("button", { name: "Link evidence to the claim: Caves teach." }).click();
  await page.locator("#oba-claims-relation-contextualizes").check();
  await page.locator("#oba-claims-source").selectOption("plato-republic");
  await page.locator("[data-claims-save]").click();
  await expect(page.getByText("Evidence link saved privately.")).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await studio(page).locator("[data-claims-remove-link]").click();
  await expect(page.getByText("Removed the evidence link.")).toBeVisible();
  const undo = page.getByRole("button", { name: "Undo removing the link" });
  await expect(undo).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByText("Evidence link restored.")).toBeVisible();
  expect(JSON.parse(storedClaims()).links).toHaveLength(1);
  const overflow = await page.evaluate(() => {
    const region = document.querySelector("[data-claims]");
    const widest = Math.max(...[region, ...region.querySelectorAll("*")].map((element) => element.getBoundingClientRect().right));
    return Math.max(widest - window.innerWidth, region.scrollWidth - region.clientWidth);
  });
  expect(overflow).toBeLessThanOrEqual(1);
});
