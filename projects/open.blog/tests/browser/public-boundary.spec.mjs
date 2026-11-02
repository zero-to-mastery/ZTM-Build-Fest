import { test, expect } from "@playwright/test";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { removeTree } from "./teardown.mjs";

// What will be public in the real Admin Studio (A8.4, ADR 0125): the Research workspace previews,
// for the whole site, exactly which research each projection publishes and why the rest is
// withheld, from the build's own projection; Evidence Studio previews one post from its unsaved
// draft; every withheld item opens where it is changed; both reflow at 320 pixels; nothing is
// written; and the build publishes what the preview said, refusing nothing it did not name.

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const binary = join(repository, "target", "debug", process.platform === "win32" ? "openblog.exe" : "openblog");
const password = randomBytes(24).toString("hex");
const MODULES = ["social", "release", "field", "optimize", "accessibility", "evidence", "research", "assistant", "analytics", "contributors", "public-site"];
const LEAK = (label) => `ZqxLeak ${label} sentinel words kept private`;
const LIBRARY = {
  version: 1,
  sources: [
    { id: "plato", kind: "work", title: "Politeia" },
    {
      id: "slings", kind: "edition", of: "plato", title: "Platonis Rempublicam",
      rights: { status: "publicDomain", note: LEAK("rightsnote") },
      identifiers: [{ scheme: "url", value: "http://files.internal/ZqxLeakUrlSegmentSentinelAbcdefghijkl" }],
    },
    { id: "bloom", kind: "translation", of: "plato", language: "en", title: "Bloom" },
  ],
};
const NOTEBOOK = {
  version: 1,
  passages: [
    { id: "cave", source: "slings", excerpt: { text: "Behold the den" }, locators: [{ kind: "page", value: "514" }] },
    { id: "moved", source: "slings", excerpt: { text: LEAK("stalepassage") }, locators: [{ kind: "page", value: "600" }] },
  ],
  notes: [{ id: "worry", kind: "question", text: LEAK("note") }],
};
const ATLAS = {
  version: 2,
  entries: [
    { id: "plato-person", kind: "person", label: "Plato", visibility: "approved" },
    { id: "politeia", kind: "work", label: "Politeia", source: "plato", visibility: "approved" },
    { id: "the-good", kind: "concept", label: LEAK("entrylabel") },
  ],
  relationships: [
    { id: "politeia-discusses-good", kind: "discusses", from: "politeia", to: "the-good", assertedBy: { kind: "author" }, evidence: [{ source: "slings" }], uncertainty: LEAK("doubt"), visibility: "approved" },
  ],
};
const ALIGNMENTS = {
  version: 1,
  alignments: [
    { id: "cave-places", label: "The cave", visibility: "approved", members: [{ source: "slings", passage: "cave" }, { source: "bloom", absent: true }] },
    { id: "stale-places", label: "Moved", visibility: "approved", rationale: LEAK("stalerationale"), approvedPassages: { moved: "0000000000000000" }, members: [{ source: "slings", passage: "moved", locators: [{ kind: "page", value: "601" }] }, { source: "bloom", absent: true }] },
  ],
};
const CLAIMS = {
  version: 1,
  claims: [
    { id: "c1", post: "cave", statement: "The cave is an image of education.", visibility: "approved" },
    { id: "c2", post: "cave", statement: LEAK("claim") },
  ],
  links: [],
};
const BODY = "## Abstract\n\nThe cave educates [@slings, page 514].\n\nSee [Plato](/atlas/plato-person/), [the Good](/atlas/the-good/) and [the places](/comparisons/cave-places/).\n\n## References\n";
const POST = `---\ntitle: Cave\ndate: 2026-10-01\nprofile: research\ncitations: notes\n---\n\n${BODY}`;
let root;
let server;
let origin;

const research = (name) => join(root, ".openblog", "private", "research", name);
const FILES = ["sources.json", "notebook.json", "atlas.json", "alignments.json", "claims.json"];
const researchBytes = () => FILES.map((name) => readFileSync(research(name), "utf8"));
const post = (name) => join(root, "content", "posts", name);
const usePreset = (preset, editorMode) => {
  const file = join(root, ".openblog", "private", "admin-preferences", `${createHash("sha256").update("writer").digest("hex")}.json`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ schemaVersion: 1, preset, density: "comfortable", editorMode, moduleOrder: MODULES, hiddenModules: [] }));
};

test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "openblog-public-boundary-"));
  cpSync(join(repository, "examples", "portable-publishing"), root, { recursive: true });
  mkdirSync(dirname(research("sources.json")), { recursive: true });
  writeFileSync(research("sources.json"), JSON.stringify(LIBRARY));
  writeFileSync(research("notebook.json"), JSON.stringify(NOTEBOOK));
  writeFileSync(research("atlas.json"), JSON.stringify(ATLAS));
  writeFileSync(research("alignments.json"), JSON.stringify(ALIGNMENTS));
  writeFileSync(research("claims.json"), JSON.stringify(CLAIMS));
  writeFileSync(post("cave.md"), POST);
  const config = JSON.parse(readFileSync(join(root, "openblog.json"), "utf8"));
  config.knowledgeAtlas = { publish: true };
  config.comparisons = { publish: true };
  config.claimEvidence = { publish: true };
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
  writeFileSync(post("cave.md"), POST);
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

const preview = (page, scope = "site") => page.locator(`[data-boundary-preview="${scope}"]`);
const projection = (page, key, scope = "site") => preview(page, scope).locator(`[data-boundary-projection="${key}"]`);
// The first item with the key: the projection listed first. The atlas query file lists the same entries
// again, in a section of its own, so a key can be in two sections.
const item = (page, key, scope = "site") => preview(page, scope).locator(`[data-boundary-item="${key}"]`).first();

/** Elements of `region` whose box ends right of it, or a region that scrolls sideways, by name. */
const overflowing = (region) =>
  region.evaluate((element) => {
    const edge = element.getBoundingClientRect().right;
    return [...element.querySelectorAll("*")]
      .filter((node) => node.getClientRects().length && node.getBoundingClientRect().right > edge + 1)
      .map((node) => `${node.tagName.toLowerCase()}.${[...node.classList].join(".")}${node.id ? `#${node.id}` : ""}`)
      .concat(element.scrollWidth - element.clientWidth > 1 ? ["the region scrolls sideways"] : [])
      .concat(element.getBoundingClientRect().right > window.innerWidth + 1 ? ["the region is wider than the window"] : []);
  });

test("the site preview names what each projection publishes and why the rest is withheld, and opens where it is changed", async ({ page }) => {
  await signIn(page);
  const before = researchBytes();
  await page.goto(`${origin}/admin/#/research/public`);
  await expect(page.getByRole("heading", { level: 2, name: "What the next build publishes" })).toBeVisible();
  await expect(preview(page)).toBeVisible();
  await expect(page.locator('nav[aria-label="Research workspace"] a[aria-current="page"]')).toHaveText("What will be public");
  await expect(page.locator("[data-boundary-status]")).toContainText(/\d+ published, \d+ withheld\./);

  // Projections sit under the panel's h2, so they are h3.
  await expect(projection(page, "atlas").getByRole("heading", { level: 3, name: "Knowledge Atlas" })).toBeVisible();
  await expect(preview(page).getByRole("heading", { level: 2 })).toHaveCount(0);
  await expect(item(page, "entry:plato-person")).toHaveAttribute("data-boundary-state", "published");
  await expect(item(page, "entry:plato-person")).toContainText("Publishes: kind, label.");
  await expect(projection(page, "atlas-query").locator('[data-boundary-item="entry:plato-person"]')).toContainText("kindLabel");
  await expect(item(page, "entry:the-good")).toHaveAttribute("data-boundary-reason", "not-approved");
  await expect(item(page, "relationship:politeia-discusses-good")).toContainText("Depends on research that is not published");
  await expect(item(page, "comparison:cave-places")).toHaveAttribute("data-boundary-state", "published");
  await expect(item(page, "comparison:stale-places")).toHaveAttribute("data-boundary-reason", "stale-approval");
  await expect(item(page, "comparison:stale-places")).toContainText("members[0].passage");
  await expect(item(page, "claim:c1")).toHaveAttribute("data-boundary-state", "published");
  await expect(item(page, "claim:c2")).toHaveAttribute("data-boundary-reason", "not-approved");
  // A withheld claim opens its post's Evidence Studio.
  await expect(item(page, "claim:c2").getByRole("link", { name: "Open claim c2" })).toHaveAttribute("href", "#/edit/posts%2Fcave.md?pane=evidence");
  const slings = projection(page, "citations").locator('[data-boundary-item="source:slings"]');
  await expect(slings.locator('[data-boundary-field="identifiers.url"]')).toContainText("A web address readers should not be given");
  await expect(preview(page).locator("[data-boundary-never]")).toContainText("Research notebook");
  // Published and withheld are told apart in words.
  await expect(item(page, "entry:plato-person").locator(".oba-visibility").first()).toHaveText("Published");
  await expect(item(page, "entry:the-good").locator(".oba-visibility").first()).toHaveText("Withheld");

  // Refresh is announced; a withheld item opens where it is changed, from the keyboard.
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.locator("[data-boundary-status]")).toContainText(/^Refreshed\. \d+ published/);
  const open = item(page, "relationship:politeia-discusses-good").getByRole("link", { name: "Open relationship politeia-discusses-good" });
  await open.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#\/research\/atlas\/relationships\/politeia-discusses-good$/);
  await expect(page.locator("#oba-atlas-heading")).toBeFocused();
  expect(researchBytes()).toEqual(before);
  expect(dialogs).toEqual([]);
});

test("one post's preview reads the unsaved draft, names its citations, claims and linked pages, and changes nothing", async ({ page }) => {
  await signIn(page);
  await page.goto(`${origin}/admin/#/edit/posts%2Fcave.md`);
  await expect(page.getByRole("textbox", { name: "Title", exact: true })).toHaveValue("Cave");
  const before = researchBytes();
  await page.keyboard.press("Alt+1");
  const markdown = page.getByRole("textbox", { name: "Markdown", exact: true });
  await markdown.fill(`${BODY}\nAnd [moved](/comparisons/stale-places/).\n`);
  await page.keyboard.press("Alt+9");
  const opener = page.getByRole("button", { name: "What this post makes public", exact: true });
  await expect(opener).toHaveAttribute("aria-controls", "oba-boundary-post");
  await expect(opener).toHaveAttribute("aria-expanded", "false");
  await opener.click();
  await expect(preview(page, "post")).toBeVisible();
  await expect(opener).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("#oba-boundary-post")).toBeVisible();
  await expect(page.getByRole("heading", { name: "What this post makes public" })).toBeFocused();
  await expect(page.locator("[data-boundary-post-stale]")).toBeHidden();
  await expect(page.locator("[data-boundary-post-status]")).toContainText("unsaved changes included");
  await expect(item(page, "source:slings", "post")).toHaveAttribute("data-boundary-state", "published");
  await expect(item(page, "claim:c1", "post")).toHaveAttribute("data-boundary-state", "published");
  await expect(item(page, "claim:c2", "post")).toHaveAttribute("data-boundary-reason", "not-approved");
  await expect(item(page, "atlas-page:plato-person", "post")).toHaveAttribute("data-boundary-state", "published");
  await expect(item(page, "atlas-page:the-good", "post")).toHaveAttribute("data-boundary-reason", "page-not-published");
  await expect(item(page, "comparison-page:stale-places", "post")).toHaveAttribute("data-boundary-reason", "page-not-published");
  await expect(preview(page, "post")).not.toContainText("ZqxLeak");
  // A claim of this post opens this post's Evidence Studio.
  await expect(item(page, "claim:c2", "post").getByRole("link", { name: "Open claim c2" })).toHaveAttribute("href", "#/edit/posts%2Fcave.md?pane=evidence");
  // Editing the draft again says the read is out of date; reading again clears it.
  await page.keyboard.press("Alt+1");
  await markdown.fill(`${BODY}
And more.
`);
  await page.keyboard.press("Alt+9");
  await expect(page.locator("[data-boundary-post-stale]")).toBeVisible();
  await opener.click();
  await expect(page.locator("[data-boundary-post-stale]")).toBeHidden();
  expect(readFileSync(post("cave.md"), "utf8")).toBe(POST);
  expect(researchBytes()).toEqual(before);
  expect(dialogs).toEqual([]);
});

test("both previews reflow at 320 pixels without sideways scrolling", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await signIn(page);
  await page.goto(`${origin}/admin/#/research/public`);
  await expect(item(page, "comparison:stale-places")).toBeVisible();
  expect(await overflowing(page.locator(".oba-boundary-panel"))).toEqual([]);

  await page.goto(`${origin}/admin/#/edit/posts%2Fcave.md?pane=evidence`);
  await page.getByRole("button", { name: "What this post makes public", exact: true }).click();
  await expect(item(page, "source:slings", "post")).toBeVisible();
  expect(await overflowing(page.locator("[data-boundary-post]"))).toEqual([]);
});

test("the build publishes what the preview says, names what it withholds, and carries no private text", async () => {
  const out = join(root, "dist-boundary");
  const output = execFileSync(binary, ["build", "--root", root, "--out", out], { encoding: "utf8", stdio: "pipe" });
  expect(output).toContain("Research published:");
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else files.push(path);
    }
  };
  walk(out);
  const atlas = JSON.parse(readFileSync(join(out, "atlas.json"), "utf8"));
  expect(atlas.entries.map((entry) => entry.id)).toEqual(["plato-person", "politeia"]);
  const comparisons = JSON.parse(readFileSync(join(out, "comparisons.json"), "utf8"));
  expect(comparisons.comparisons.map((comparison) => comparison.id)).toEqual(["cave-places"]);
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    expect(text, file).not.toContain("ZqxLeak");
    expect(text, file).not.toContain("files.internal");
  }
  rmSync(out, { recursive: true, force: true });
});
