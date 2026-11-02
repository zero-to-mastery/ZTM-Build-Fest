import { test, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { removeTree } from "./teardown.mjs";

// Relationship trails on a Knowledge Atlas entry page (ADR 0175, #75), built and served by the real
// binary from a private atlas. Without JavaScript the trail is a complete, ordered, semantic list
// of published relationships with their type, direction, evidence and uncertainty, and a cycle is a
// sentence. With it, native controls filter whole steps and a status line says what is shown;
// Tab goes through with no trap, nothing private appears, print shows everything, a bounded graph
// stays bounded, and the regions do not overflow a 320px screen (a 1280px window at 400% zoom).

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const binary = join(repository, "target", "debug", process.platform === "win32" ? "openblog.exe" : "openblog");
const fixture = JSON.parse(readFileSync(join(repository, "tests", "fixtures", "atlas-trail.json"), "utf8"));
const POLICY = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'";
const PRIVATE = "PRIVATE-TRAIL-MARKER";
const LONG_LABEL = "the extraordinarily long and unbroken allegoryofthecaveandtheshadowsonthewallthatthe prisoners mistake for the whole of reality";
const LONG_NOTE = "an equally long and unbroken doubt_about_the_dating_of_the_dialogue_that_nobody_has_settled_in_twenty_five_centuries_of_scholarship";

const entries = [
  ...fixture.atlas.entries,
  { id: "long", kind: "concept", label: LONG_LABEL, visibility: "approved" },
  { id: "hub", kind: "concept", label: "Hub", visibility: "approved" },
  ...Array.from({ length: 260 }, (_, n) => ({ id: `leaf-${String(n).padStart(3, "0")}`, kind: "concept", label: `Leaf ${String(n).padStart(3, "0")}`, visibility: "approved" })),
];
const relationships = [
  ...fixture.atlas.relationships,
  {
    id: "r-long", kind: "influenced", from: "long", to: "plato", visibility: "approved",
    assertedBy: { kind: "author" }, confidence: "tentative", evidence: [{ source: "plato-republic" }], uncertainty: LONG_NOTE,
  },
  ...Array.from({ length: 260 }, (_, n) => ({
    id: `r-leaf-${String(n).padStart(3, "0")}`, kind: "influenced", from: "hub", to: `leaf-${String(n).padStart(3, "0")}`,
    visibility: "approved", assertedBy: { kind: "author" }, confidence: "plausible", evidence: [{ source: "plato-republic" }],
    ...(n % 7 === 0 ? { uncertainty: "Doubted." } : {}),
  })),
];
const ATLAS = { version: 1, entries, relationships };
const NOTEBOOK = { version: 1, passages: [], notes: [] };
let root;
let server;
let origin;

test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "openblog-atlas-trail-"));
  writeFileSync(join(root, "openblog.json"), JSON.stringify({ title: "Trails", url: "https://trails.example.org", author: { name: "Site Author" }, knowledgeAtlas: { publish: true } }));
  mkdirSync(join(root, "content", "posts"), { recursive: true });
  writeFileSync(join(root, "content", "posts", "cave.md"), "---\ntitle: The cave\ndate: 2026-10-19\n---\nA post.\n");
  const research = join(root, ".openblog", "private", "research");
  mkdirSync(research, { recursive: true });
  writeFileSync(join(research, "sources.json"), JSON.stringify(fixture.library));
  writeFileSync(join(research, "notebook.json"), JSON.stringify(NOTEBOOK));
  writeFileSync(join(research, "atlas.json"), JSON.stringify(ATLAS));
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
    expect((await fetch(`${origin}/atlas/plato/`)).ok).toBe(true);
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

const section = (page) => page.locator("ob-atlas-trail .ob-atlas-trail-section");
const steps = (page) => page.locator("ob-atlas-trail li.ob-trail-step");
const visibleSteps = (page) => page.locator("ob-atlas-trail li.ob-trail-step:not([hidden])");
const tools = (page) => page.getByRole("group", { name: "Trail filters" });
const status = (page) => page.locator(".ob-trail-status");

async function open(page, id = "plato") {
  await page.goto(`${origin}/atlas/${id}/`);
  await expect(page.locator("ob-atlas-trail")).toHaveCount(1);
}

async function enhanced(page, id = "plato") {
  await open(page, id);
  await expect(tools(page)).toBeVisible();
}

async function overflow(page) {
  return page.evaluate(() => {
    const region = document.querySelector("ob-atlas-trail");
    const elements = [region, ...region.querySelectorAll("*")];
    const limit = window.innerWidth;
    const widest = Math.max(...elements.map((element) => element.getBoundingClientRect().right));
    return {
      page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      content: Math.max(widest - limit, region.scrollWidth - region.clientWidth),
    };
  });
}

test.describe("without JavaScript", () => {
  test.use({ javaScriptEnabled: false });

  test("the trail is a complete semantic list with type, direction, evidence and uncertainty on the first steps and the sentence and a link beyond", async ({ page }) => {
    await open(page);
    const trail = page.getByRole("region", { name: "Relationship trail" });
    await expect(trail).toBeVisible();
    await expect(page.locator(".ob-trail-tools")).toHaveCount(0);
    // Steps are list items of ordered lists, under headings that say how far they are.
    await expect(trail.getByRole("heading", { level: 3 })).toHaveText(["One step from Plato", "Two steps from Plato"]);
    expect(await steps(page).count()).toBe(6);
    await expect(trail.locator("ol.ob-trail-steps > li")).toHaveCount(6);
    await expect(trail.locator("ol.ob-trail-depths > li")).toHaveCount(2);
    for (const step of await steps(page).all()) {
      // The first step out has every fact; a step further out is its sentence, which way it was
      // followed and a link to the relationship in full (the page keeps its data for the filters).
      const facts = (await step.getAttribute("data-depth")) === "1" ? 1 : 0;
      for (const term of ["Type", "Direction", "Asserted by", "Confidence", "Standing", "Evidence", "Uncertainty"]) {
        await expect(step.locator("dt", { hasText: new RegExp(`^${term}$`) })).toHaveCount(facts);
      }
      await expect(step.locator("p.ob-trail-statement")).toHaveCount(1);
      await expect(step.getByRole("link", { name: "The relationship in full" })).toHaveCount(1);
    }
    await expect(page.locator("#atlas-trail-r-discusses")).toContainText("Followed in the direction it was stated");
    // Direction is said in words, both ways, and never inferred where it is not stated.
    await expect(trail).toContainText("This step follows it backward, against the direction it was stated");
    await expect(trail).toContainText("this kind of relationship reads the same in both directions");
    await expect(trail).toContainText("It is not a line of influence");
    await expect(page.locator("#atlas-trail-r-related")).not.toContainText("against the direction it was stated");
    // Uncertainty and dissent are shown with the claim.
    await expect(page.locator("#atlas-trail-r-authored")).toContainText("The dating is unsettled.");
    await expect(page.locator("#atlas-trail-r-authored")).toContainText("Contested: 1 recorded dissent.");
    await expect(page.locator("#atlas-trail-r-developed")).toContainText("None stated. That is not a claim that it is certain.");
    // A step that closes a loop says so, and the trail does not go on from it.
    await expect(page.locator("#atlas-trail-r-influenced")).toContainText("already on this trail");
    await expect(page.locator("#atlas-trail-r-discusses")).toContainText("already on this trail");
    await expect(page.locator("#atlas-trail-r-authored")).not.toContainText("already on this trail");
    // Nothing private.
    expect(await page.content()).not.toContain(PRIVATE);
  });

  test("the skip link moves past the trail, and following a loop never traps navigation", async ({ page }) => {
    await open(page);
    await page.getByRole("link", { name: "Skip the trail" }).click();
    await expect(page).toHaveURL(`${origin}/atlas/plato/#atlas-trail-end`);
    await expect(page.locator("#atlas-trail-end")).toBeFocused();
    // plato -> republic -> allegory of the cave -> plato: a cycle of ordinary pages.
    await page.goto(`${origin}/atlas/plato/`);
    await page.locator("#atlas-trail-r-authored").getByRole("link", { name: "Republic" }).first().click();
    await expect(page).toHaveURL(`${origin}/atlas/republic/`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Republic");
    await page.locator("#atlas-trail-r-discusses").getByRole("link", { name: "Allegory of the cave" }).first().click();
    await expect(page).toHaveURL(`${origin}/atlas/cave/`);
    await page.locator("#atlas-trail-r-influenced").getByRole("link", { name: "Plato" }).first().click();
    await expect(page).toHaveURL(`${origin}/atlas/plato/`);
    await expect(page.getByRole("region", { name: "Relationship trail" })).toBeVisible();
    // The browser's own history goes back through the loop, one page at a time.
    await page.goBack();
    await expect(page).toHaveURL(`${origin}/atlas/cave/`);
    await page.goBack();
    await expect(page).toHaveURL(`${origin}/atlas/republic/`);
  });

  test("a long label and a long note wrap inside the region at 320px", async ({ browser }) => {
    const context = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 320, height: 640 } });
    const page = await context.newPage();
    await open(page);
    await expect(page.locator("#atlas-trail-r-long")).toContainText(LONG_NOTE);
    const measured = await overflow(page);
    expect(measured.page).toBeLessThanOrEqual(0);
    expect(measured.content).toBeLessThanOrEqual(1);
    await context.close();
  });
});

test("the controls are a labelled group of native controls and the status says what is shown", async ({ page }) => {
  await enhanced(page);
  await expect(tools(page).getByLabel("Relationship type")).toBeVisible();
  await expect(tools(page).getByLabel("Direction followed")).toBeVisible();
  await expect(tools(page).getByLabel("How far")).toBeVisible();
  await expect(tools(page).getByLabel("Only contested or uncertain relationships")).toBeVisible();
  await expect(tools(page).getByRole("button", { name: "Reset filters" })).toBeVisible();
  await expect(status(page)).toHaveAttribute("role", "status");
  await expect(status(page)).toContainText("Showing 6 of 6 relationships.");
  expect(await visibleSteps(page).count()).toBe(6);
  // The type choices are only what the trail has.
  const kinds = await tools(page).getByLabel("Relationship type").locator("option").allTextContents();
  expect(kinds).toEqual(["Every type", "authored", "developed", "influenced", "related to", "discusses"]);
});

test("a filter hides whole steps, keeps what a shown step says, and the status names every filter", async ({ page }) => {
  await enhanced(page);
  await tools(page).getByLabel("Direction followed").selectOption("backward");
  await expect(status(page)).toContainText("Showing 3 of 6 relationships; against the direction stated; relationships that read the same both ways are shown under either choice.");
  await expect(visibleSteps(page)).toHaveCount(3);
  // A relationship that reads the same both ways is shown under either direction, and is never
  // described as followed against the one it was stated in.
  await expect(page.locator("#atlas-trail-r-related")).toBeVisible();
  await tools(page).getByLabel("Direction followed").selectOption("forward");
  await expect(page.locator("#atlas-trail-r-related")).toBeVisible();
  await expect(page.locator("#atlas-trail-r-related")).toHaveAttribute("data-direction", "symmetric");
  await expect(page.locator("#atlas-trail-r-influenced")).toBeHidden();
  await tools(page).getByLabel("Direction followed").selectOption("backward");
  // A distance with nothing left is hidden with its heading; steps stay in the page.
  await tools(page).getByLabel("How far").selectOption("1");
  await expect(status(page)).toContainText("within one step");
  await tools(page).getByLabel("Relationship type").selectOption("influenced");
  await expect(status(page)).toContainText("type: influenced");
  await expect(visibleSteps(page)).toHaveCount(2);
  for (const step of await visibleSteps(page).all()) {
    await expect(step.locator("dt", { hasText: /^Direction$/ })).toBeVisible();
    await expect(step.locator("dt", { hasText: /^Evidence$/ })).toBeVisible();
    await expect(step.locator("dt", { hasText: /^Uncertainty$/ })).toBeVisible();
  }
  await expect(page.getByRole("heading", { level: 3, name: "Two steps from Plato" })).toBeHidden();
  expect(await steps(page).count()).toBe(6);
  await tools(page).getByLabel("Only contested or uncertain relationships").check();
  await expect(visibleSteps(page)).toHaveCount(1);
  await expect(visibleSteps(page)).toContainText(LONG_NOTE);
  await tools(page).getByLabel("Relationship type").selectOption("authored");
  await expect(visibleSteps(page)).toHaveCount(0);
  await expect(status(page)).toContainText("Nothing matches; reset the filters to see the whole trail.");
  // Reset puts everything back and leaves focus on the button that was pressed.
  const reset = tools(page).getByRole("button", { name: "Reset filters" });
  await reset.focus();
  await page.keyboard.press("Enter");
  await expect(visibleSteps(page)).toHaveCount(6);
  await expect(status(page)).toContainText("Showing 6 of 6 relationships.");
  await expect(reset).toBeFocused();
  await expect(tools(page).getByLabel("Direction followed")).toHaveValue("");
});

test("keyboard: the controls and the steps are in one Tab order, with no focus trap", async ({ page }) => {
  await enhanced(page);
  const kind = tools(page).getByLabel("Relationship type");
  await kind.focus();
  await page.keyboard.press("ArrowDown");
  await expect(status(page)).toContainText("type: authored");
  await page.keyboard.press("Tab");
  await expect(tools(page).getByLabel("Direction followed")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(tools(page).getByLabel("How far")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(tools(page).getByLabel("Only contested or uncertain relationships")).toBeFocused();
  await page.keyboard.press("Space");
  await expect(status(page)).toContainText("only contested or uncertain relationships");
  await page.keyboard.press("Tab");
  await expect(tools(page).getByRole("button", { name: "Reset filters" })).toBeFocused();
  // Tab goes on into the first visible step, and Shift+Tab comes back to the controls and the skip link before them.
  await page.keyboard.press("Tab");
  await expect(visibleSteps(page).first().getByRole("link").first()).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(tools(page).getByRole("button", { name: "Reset filters" })).toBeFocused();
  await tools(page).getByLabel("Relationship type").focus();
  await page.keyboard.press("Shift+Tab");
  await expect(page.getByRole("link", { name: "Skip the trail" })).toBeFocused();
  // A hidden step is never reachable: Tab through the whole page and look at every stop.
  expect(await page.locator("ob-atlas-trail li.ob-trail-step[hidden] a").count()).toBeGreaterThan(0);
  await page.getByRole("button", { name: "Reset filters" }).focus();
  await page.getByLabel("Only contested or uncertain relationships").uncheck();
  await tools(page).getByLabel("Relationship type").selectOption("authored");
  await tools(page).getByLabel("Relationship type").focus();
  for (let press = 0; press < 40; press += 1) {
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => Boolean(document.activeElement?.closest("[hidden]"))), `stop ${press}`).toBe(false);
  }
});

test("a skip link and the end of the trail are reachable from the keyboard", async ({ page }) => {
  await enhanced(page);
  await page.getByRole("link", { name: "Skip the trail" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#atlas-trail-end")).toBeFocused();
});

test("print shows the whole trail and none of the controls, whatever a filter hid", async ({ page }) => {
  await enhanced(page);
  await tools(page).getByLabel("Relationship type").selectOption("authored");
  await expect(visibleSteps(page)).toHaveCount(1);
  await page.emulateMedia({ media: "print" });
  await expect(tools(page)).toBeHidden();
  for (const step of await steps(page).all()) await expect(step).toBeVisible();
  await expect(page.getByRole("heading", { level: 3, name: "Two steps from Plato" })).toBeVisible();
  await page.emulateMedia({ media: "screen" });
  await expect(visibleSteps(page)).toHaveCount(1);
});

test("the regions do not overflow at 320px, nor at 400% zoom, with a long label and a long note", async ({ browser }) => {
  for (const viewport of [{ width: 320, height: 640 }, { width: 1280, height: 800 }]) {
    const context = await browser.newContext({ viewport, deviceScaleFactor: viewport.width === 1280 ? 4 : 1 });
    const page = await context.newPage();
    await enhanced(page);
    // At 400% zoom a 1280px window is a 320 CSS pixel layout viewport.
    if (viewport.width === 1280) {
      const session = await context.newCDPSession(page);
      await session.send("Emulation.setDeviceMetricsOverride", { width: 320, height: 640, deviceScaleFactor: 4, mobile: false });
    }
    let measured = await overflow(page);
    expect(measured.page, `plato at ${viewport.width}`).toBeLessThanOrEqual(0);
    expect(measured.content, `plato at ${viewport.width}`).toBeLessThanOrEqual(1);
    // The long entry's own trail, and the controls with a filter in force.
    await tools(page).getByLabel("Relationship type").selectOption("influenced");
    measured = await overflow(page);
    expect(measured.content, `filtered at ${viewport.width}`).toBeLessThanOrEqual(1);
    await page.goto(`${origin}/atlas/long/`);
    await expect(tools(page)).toBeVisible();
    measured = await overflow(page);
    expect(measured.page, `long at ${viewport.width}`).toBeLessThanOrEqual(0);
    expect(measured.content, `long at ${viewport.width}`).toBeLessThanOrEqual(1);
    for (const control of await tools(page).locator("select, button, input").all()) {
      if (!(await control.isVisible())) continue;
      const box = await control.boundingBox();
      expect(box.x + box.width).toBeLessThanOrEqual(320 + 1);
    }
    await context.close();
  }
});

test("a large graph stays bounded: 50 steps, compact beyond the first, a stated stop, and filters that still work", async ({ page }) => {
  await enhanced(page, "hub");
  expect(await steps(page).count()).toBe(50);
  await expect(section(page)).toContainText("The trail stops after 50 relationships; more exist.");
  await expect(status(page)).toContainText("Showing 50 of 50 relationships.");
  await tools(page).getByLabel("Only contested or uncertain relationships").check();
  // Every seventh of the 50 steps carries a stated doubt: 0, 7, ... 49.
  await expect(visibleSteps(page)).toHaveCount(8);
  await expect(status(page)).toContainText("Showing 8 of 50 relationships");
  const measured = await overflow(page);
  expect(measured.content).toBeLessThanOrEqual(1);
});

test("nothing private is in any trail, and the page is the same for every reader", async ({ page }) => {
  for (const id of ["plato", "republic", "cave", "socrates"]) {
    await open(page, id);
    expect(await page.content(), id).not.toContain(PRIVATE);
    expect(await section(page).innerText(), id).not.toContain(PRIVATE);
  }
  const query = await (await page.request.get(`${origin}/atlas-query.json`)).text();
  expect(query).not.toContain(PRIVATE);
});

test("it works under a strict content security policy, with no request of its own", async ({ page }) => {
  await page.route(`${origin}/atlas/plato/`, async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, headers: { ...response.headers(), "content-security-policy": POLICY } });
  });
  await page.addInitScript(() => {
    window.__violations = [];
    document.addEventListener("securitypolicyviolation", (event) => {
      window.__violations.push(`${event.violatedDirective} ${event.blockedURI}`);
    });
  });
  const requests = [];
  page.on("request", (request) => requests.push(new URL(request.url()).pathname));
  await enhanced(page);
  await tools(page).getByLabel("Relationship type").selectOption("authored");
  await expect(visibleSteps(page)).toHaveCount(1);
  // The page's own inline theme script is outside this test; the component adds no violation.
  const violations = await page.evaluate(() => window.__violations);
  expect(violations.filter((violation) => !violation.startsWith("script-src-elem inline"))).toEqual([]);
  expect(requests.filter((path) => path.includes("atlas-query") || path.endsWith(".json"))).toEqual([]);
});

test("a page without a trail loads nothing for it", async ({ page }) => {
  const requests = [];
  page.on("request", (request) => requests.push(request.url()));
  await page.goto(`${origin}/atlas/`);
  await expect(page.locator("h1")).toHaveText("Knowledge Atlas");
  await page.goto(`${origin}/posts/cave/`);
  await expect(page.locator("h1")).toHaveText("The cave");
  expect(requests.some((url) => url.includes("ob-atlas-trail"))).toBe(false);
  await expect(page.locator("ob-atlas-trail")).toHaveCount(0);
});
