import { test, expect } from "@playwright/test";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { removeTree } from "./teardown.mjs";

// The real Admin Studio and the real Knowledge Atlas API (core validation, revision-checked
// store) over a small library, notebook and atlas. Covers keyboard-only authoring, typed endpoint
// pickers, the textual explorer, a refused cycle, hostile labels, the notebook's concept links,
// and a phone-width layout.

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const binary = join(repository, "target", "debug", process.platform === "win32" ? "openblog.exe" : "openblog");
const password = randomBytes(24).toString("hex");
const HOSTILE = "<img src=x onerror=alert(1)> Πλάτων";
const LIBRARY = {
  version: 1,
  sources: [
    { id: "plato-republic", kind: "work", title: "Πολιτεία" },
    { id: "slings-2003", kind: "edition", of: "plato-republic", title: "Platonis Rempublicam" },
  ],
};
const NOTEBOOK = {
  version: 1,
  passages: [{ id: "p1", source: "slings-2003", excerpt: { text: "the cave" }, locators: [{ kind: "page", value: "514" }] }],
  notes: [{ id: "n1", kind: "question", text: "Why a cave?", concepts: ["allegory"] }],
};
const ATLAS = (relationships = []) => ({
  version: 1,
  entries: [
    { id: "plato", kind: "person", label: HOSTILE, visibility: "private" },
    { id: "politeia", kind: "work", label: "Politeia", source: "plato-republic", visibility: "private" },
    { id: "good", kind: "concept", label: "The Good", visibility: "private" },
    { id: "form", kind: "concept", label: "Form", visibility: "private" },
  ],
  relationships: [
    { id: "good-specializes-form", kind: "specializes", from: "good", to: "form", assertedBy: { kind: "author" }, confidence: "tentative", unsourced: true, visibility: "private" },
    ...relationships,
  ],
});
let root;
let server;
let origin;

const research = (name) => join(root, ".openblog", "private", "research", name);
const writeResearch = (relationships) => {
  mkdirSync(dirname(research("sources.json")), { recursive: true });
  writeFileSync(research("sources.json"), JSON.stringify(LIBRARY));
  writeFileSync(research("notebook.json"), JSON.stringify(NOTEBOOK));
  writeFileSync(research("atlas.json"), JSON.stringify(ATLAS(relationships)));
};
const storedAtlas = () => readFileSync(research("atlas.json"), "utf8");

test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "openblog-atlas-"));
  cpSync(join(repository, "examples", "portable-publishing"), root, { recursive: true });
  writeResearch();
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

test.beforeEach(() => writeResearch());

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

const heading = (page) => page.locator("#oba-atlas-heading");
const outgoing = (page) => page.locator('[data-atlas-direction="outgoing"]');
const incoming = (page) => page.locator('[data-atlas-direction="incoming"]');

test("an entry and a relationship are created and explored from the keyboard alone", async ({ page }) => {
  await openAdmin(page, "#/atlas");
  const create = page.getByRole("button", { name: "New entry", exact: true });
  await expect(create).toBeVisible();
  await create.focus();
  await page.keyboard.press("Enter");
  await expect(heading(page)).toBeFocused();
  await expect(heading(page)).toHaveText("New entry");
  await page.locator("#oba-atlas-entry-kind").focus();
  await page.locator("#oba-atlas-entry-kind").selectOption("person");
  await page.keyboard.press("Tab");
  await expect(page.locator("#oba-atlas-entry-label")).toBeFocused();
  await page.keyboard.type("Socrates");
  await expect(page.locator("#oba-atlas-entry-id")).toHaveValue("socrates");
  await page.getByRole("button", { name: "Add entry", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(heading(page)).toHaveText("Socrates");
  await expect(heading(page)).toBeFocused();
  await expect(page.getByText("Entry saved to the private atlas.")).toBeVisible();

  await page.getByRole("button", { name: "Add a relationship from this entry" }).focus();
  await page.keyboard.press("Enter");
  await expect(heading(page)).toHaveText("New relationship");
  await expect(page.locator("#oba-atlas-relationship-from")).toHaveValue("socrates");
  await page.locator("#oba-atlas-relationship-kind").selectOption("influenced");
  await expect(page.locator("#oba-atlas-relationship-kind")).toBeFocused();
  await page.locator("#oba-atlas-relationship-to").selectOption("good");
  await page.locator("#oba-atlas-relationship-unsourced").focus();
  await page.keyboard.press("Space");
  await expect(page.locator("#oba-atlas-relationship-unsourced")).toBeChecked();
  await page.locator("#oba-atlas-relationship-uncertainty").fill("Only Plato reports it.");
  await page.getByRole("button", { name: "Add relationship", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText("Relationship saved to the private atlas.")).toBeVisible();
  await expect(heading(page)).toBeFocused();
  expect(JSON.parse(storedAtlas()).relationships.map((relationship) => relationship.id)).toContain("socrates-influenced-good");

  await page.getByRole("button", { name: "Explore The Good" }).focus();
  await page.keyboard.press("Enter");
  await expect(heading(page)).toHaveText("The Good");
  await expect(incoming(page)).toContainText("Incoming (1)");
  await expect(incoming(page)).toContainText("The Good influenced by Socrates");
  await expect(incoming(page)).toContainText("Unsourced draft: no evidence cited yet");
  await expect(incoming(page)).toContainText("Uncertain: Only Plato reports it.");
  await expect(incoming(page)).toContainText("Tentative confidence, as held by the asserting party");
  await expect(outgoing(page)).toContainText("The Good specializes Form");
});

test("endpoint pickers follow the relationship kind, and a cycle is refused at its field with the file unchanged", async ({ page }) => {
  await openAdmin(page, "#/atlas");
  await page.getByRole("button", { name: "New relationship", exact: true }).click();
  await expect(heading(page)).toBeFocused();
  await page.locator("#oba-atlas-relationship-kind").selectOption("authored");
  await expect(page.locator("#oba-atlas-relationship-from option:not([value=''])")).toHaveCount(1);
  await expect(page.locator("#oba-atlas-relationship-from option[value='plato']")).toHaveCount(1);
  await expect(page.locator("#oba-atlas-relationship-to option:not([value=''])")).toHaveCount(1);
  await expect(page.locator("#oba-atlas-relationship-to option[value='politeia']")).toHaveCount(1);

  const before = storedAtlas();
  await page.locator("#oba-atlas-relationship-kind").selectOption("specializes");
  await page.locator("#oba-atlas-relationship-from").selectOption("form");
  await page.locator("#oba-atlas-relationship-to").selectOption("good");
  await page.locator("#oba-atlas-relationship-unsourced").check();
  await page.getByRole("button", { name: "Add relationship", exact: true }).click();
  await expect(page.locator("#oba-atlas-relationship-error")).toContainText(/cycle/i);
  await expect(page.locator("#oba-atlas-relationship-to")).toBeFocused();
  await expect(page.locator("#oba-atlas-relationship-to")).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByText("Not saved. The stored atlas is unchanged.")).toBeVisible();
  expect(storedAtlas()).toBe(before);
});

test("filters narrow the list, hostile labels stay text, and contested relationships say so", async ({ page }) => {
  writeResearch([
    {
      id: "plato-authored-politeia", kind: "authored", from: "plato", to: "politeia", assertedBy: { kind: "author" }, confidence: "plausible",
      evidence: [{ source: "slings-2003", locators: [{ kind: "page", value: "514" }] }], uncertainty: "The dating is unsettled.",
      contestedBy: [{ by: { kind: "named", name: "A later editor" }, note: "Doubts it." }], visibility: "private",
    },
  ]);
  await openAdmin(page, "#/atlas");
  await expect(page.locator("[data-atlas-entry]")).toHaveCount(4);
  await page.locator("#oba-atlas-kind-filter").selectOption("concept");
  await expect(page.locator("[data-atlas-entry]")).toHaveCount(2);
  await page.locator("#oba-atlas-search").fill("form");
  await expect(page.locator("[data-atlas-entry]")).toHaveCount(1);
  await page.locator("#oba-atlas-kind-filter").selectOption("");
  await page.locator("#oba-atlas-search").fill("πλάτων");
  await expect(page.locator("[data-atlas-entry]")).toHaveCount(1);
  await page.locator('[data-atlas-entry="plato"]').click();
  await expect(heading(page)).toHaveText(HOSTILE);
  await expect(page.locator('img[src="x"]')).toHaveCount(0);
  await expect(outgoing(page)).toContainText(`${HOSTILE} authored Politeia`);
  await expect(outgoing(page)).toContainText("Contested: 1 recorded dissent (by A later editor)");
  await expect(outgoing(page)).toContainText("Uncertain: The dating is unsettled.");
  await expect(page.locator("[data-atlas-explorer]")).not.toContainText(/consensus|agreed|established/i);
});

test("a note's concept link opens the atlas and adds the missing concept", async ({ page }) => {
  await openAdmin(page, "#/research");
  await page.locator('[data-entry-id="n1"]').click();
  const link = page.locator('[data-atlas-concepts] a', { hasText: "allegory" });
  await expect(link).toBeVisible();
  await link.focus();
  await page.keyboard.press("Enter");
  await expect(heading(page)).toHaveText("New concept allegory");
  await expect(page.locator("#oba-atlas-entry-id")).toHaveValue("allegory");
  await expect(page.getByRole("button", { name: "Add concept allegory" })).toBeVisible();
  await page.locator("#oba-atlas-entry-label").fill("Allegory");
  await page.getByRole("button", { name: "Add entry", exact: true }).click();
  await expect(heading(page)).toHaveText("Allegory");
  await expect(page.locator("[data-atlas-notes]")).toContainText("Why a cave? (question, n1)");
  await expect(page.getByRole("button", { name: "Add concept allegory" })).toHaveCount(0);
});

test("the atlas fits a phone screen without sideways scrolling", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openAdmin(page, "#/atlas/plato");
  await expect(heading(page)).toHaveText(HOSTILE);
  await expect(page.locator("[data-atlas-explorer]")).toContainText("Outgoing");
  // The atlas region (lists, explorer and editor) stays inside the viewport and never scrolls sideways.
  const overflow = () =>
    page.evaluate(() => {
      const region = document.querySelector("#oba-atlas-lists");
      const widest = Math.max(...[region, ...region.querySelectorAll("*")].map((element) => element.getBoundingClientRect().right));
      return Math.max(widest - window.innerWidth, region.scrollWidth - region.clientWidth);
    });
  expect(await overflow()).toBeLessThanOrEqual(1);
  await page.getByRole("button", { name: "Add a relationship from this entry" }).click();
  await page.getByRole("button", { name: "Add evidence", exact: true }).click();
  await expect(page.locator("#oba-atlas-relationship-evidence-0-source")).toBeFocused();
  await page.getByRole("button", { name: "Add a dissent" }).click();
  await expect(page.locator("#oba-atlas-relationship-dissent-0-name")).toBeFocused();
  expect(await overflow()).toBeLessThanOrEqual(1);
});
