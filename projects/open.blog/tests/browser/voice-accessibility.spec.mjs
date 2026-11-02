import { test, expect } from "@playwright/test";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes } from "node:crypto";

// The accessibility bar for the voice feature (epic #410, task #469), from the real binary and the real page:
// keyboard-only use of the session, library, guide, erase and invitation; accessible names; what the live region
// says (and that the clock is not a live region); a 320px screen and 400% zoom (a 320px-wide viewport); reduced
// motion; and no sideways scrolling. Layout is measured on the region under test with a tolerance: CI fonts are
// wider than the ones on a developer machine, so nothing here depends on a font's metrics.

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const binary = join(repository, "target", "debug", process.platform === "win32" ? "openblog.exe" : "openblog");
const password = randomBytes(24).toString("hex");
const shots = join(repository, "tests", "browser", "test-results", "voice-a11y");
const TOLERANCE = 1.5;
const LONG = "an_extraordinarily_long_unbroken_word_that_must_wrap_instead_of_overflowing_a_small_screen_at_all_even_at_320";
const MODULES = ["social", "release", "field", "optimize", "accessibility", "evidence", "research", "assistant", "analytics", "contributors", "public-site"];
let root;
let server;
let origin;

test.describe.configure({ mode: "serial" });
test.use({ actionTimeout: 10000 });

test.beforeAll(async () => {
  mkdirSync(shots, { recursive: true });
  root = mkdtempSync(join(tmpdir(), "openblog-voice-a11y-"));
  mkdirSync(join(root, "content", "posts"), { recursive: true });
  writeFileSync(join(root, "content", "posts", "voice-demo.md"), "---\ntitle: Voice demo\ndate: 2026-10-01\ndraft: true\n---\nA draft body for the demo.\n");
  writeFileSync(join(root, "openblog.json"), JSON.stringify({ title: "Voice", url: "https://voice.example.org", author: { name: "Site Author" } }));
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
    expect((await fetch(`${origin}/`)).ok).toBe(true);
  }).toPass({ timeout: 30000 });
});

test.afterAll(async () => {
  if (server && server.exitCode === null) {
    const stopped = once(server, "exit");
    server.kill();
    await stopped;
  }
  // Windows can hold the stopped server's files for a moment.
  if (root) {
    try { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* known Windows flake */ }
  }
});

test.beforeEach(({ page }) => {
  page.on("dialog", (dialog) => {
    throw new Error(`unexpected ${dialog.type()}: ${dialog.message()}`);
  });
});

async function signIn(page, hash = "#/voice") {
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

/** Give up whatever session is open; a scrap names the session it means. */
async function scrapOpen(page) {
  const standing = await api(page, "GET", "voice/status");
  return api(page, "DELETE", "voice/session", { sessionId: standing.body?.session?.sessionId ?? null });
}

async function api(page, method, path, body) {
  return page.evaluate(async ([method, path, body]) => {
    const session = await (await fetch("/admin/api/session")).json();
    const reply = await fetch(`/admin/api/${path}`, {
      method,
      headers: { "content-type": "application/json", "x-csrf-token": session.csrf },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: reply.status, body: await reply.json().catch(() => null) };
  }, [method, path, body]);
}

const voiceFiles = () => {
  const found = [];
  for (const folder of [join(root, ".openblog", "private", "context", "voice"), join(root, "assistant", "context", "voice")]) {
    if (existsSync(folder)) for (const name of readdirSync(folder)) if (name.endsWith(".md")) found.push(join(folder, name));
  }
  return found;
};

/** How far the region under test reaches past the screen, and the page itself, in pixels. */
const sideways = (page, selector) =>
  page.evaluate((selector) => {
    const region = document.querySelector(selector);
    const width = document.documentElement.clientWidth;
    let widest = 0;
    let culprit = "";
    for (const node of region.querySelectorAll("*")) {
      const box = node.getBoundingClientRect();
      if (box.width && box.right > widest) {
        widest = box.right;
        culprit = `${node.tagName.toLowerCase()}.${node.className}`;
      }
    }
    return { region: region.scrollWidth - region.clientWidth, widest: widest - width, page: document.documentElement.scrollWidth - width, culprit };
  }, selector);

async function fits(page, selector, label) {
  const overflow = await sideways(page, selector);
  expect(overflow.region, `${label}: region ${overflow.culprit}`).toBeLessThanOrEqual(TOLERANCE);
  expect(overflow.widest, `${label}: widest ${overflow.culprit}`).toBeLessThanOrEqual(TOLERANCE);
  expect(overflow.page, `${label}: page`).toBeLessThanOrEqual(TOLERANCE);
}

/** Every control inside the region, with the name a screen reader would give it. Empty names are the findings. */
const unnamed = (page, selector) =>
  page.evaluate((selector) => {
    const text = (node) => {
      let out = "";
      for (const child of node.childNodes) {
        if (child.nodeType === 3) out += child.textContent;
        else if (child.nodeType === 1 && child.getAttribute("aria-hidden") !== "true" && !child.hidden) out += text(child);
      }
      return out;
    };
    const nameOf = (node) => {
      const by = node.getAttribute("aria-labelledby");
      if (by) return by.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" ").trim();
      const label = node.getAttribute("aria-label");
      if (label && label.trim()) return label.trim();
      if (node.labels && node.labels.length) return [...node.labels].map((l) => text(l)).join(" ").trim();
      if (node.tagName === "INPUT" && ["button", "submit"].includes(node.type)) return node.value.trim();
      return (text(node) || node.getAttribute("title") || "").trim();
    };
    const region = document.querySelector(selector);
    const missing = [];
    for (const node of region.querySelectorAll("button, a[href], input:not([type=hidden]), textarea, select, [role=button], [role=timer]")) {
      if (node.closest("[hidden]")) continue;
      if (!nameOf(node)) missing.push(`${node.tagName.toLowerCase()}.${node.className}`);
    }
    return missing;
  }, selector);

/** Press Tab until the focused element matches, or fail after `max` presses. */
async function tabTo(page, selector, max = 40) {
  for (let i = 0; i < max; i += 1) {
    await page.keyboard.press("Tab");
    if (await page.evaluate((selector) => document.activeElement?.matches(selector) ?? false, selector)) return;
  }
  throw new Error(`Tab never reached ${selector}`);
}

/** After a scripted focus(), step back and forward so the browser treats focus as the keyboard's. */
async function viaKeyboard(page) {
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
}

/** The focused control shows a ring: an outline, or a shadow standing in for one. */
const showsFocus = (page) =>
  page.evaluate(() => {
    const style = getComputedStyle(document.activeElement);
    return (style.outlineStyle !== "none" && parseFloat(style.outlineWidth) > 0) || style.boxShadow !== "none";
  });

const cards = (page) => page.locator("[data-prompt].oba-voice-card");

test("the invitation is a labelled region, is reached and dismissed by keyboard, and fits 320px", async ({ page }) => {
  await signIn(page, "#/overview");
  await page.setViewportSize({ width: 320, height: 640 });
  const card = page.locator("[data-voice-invitation]");
  await expect(card).toBeVisible();
  await expect(page.getByRole("group", { name: "Gather your voice" }).or(page.getByRole("region", { name: "Gather your voice" })).first()).toBeVisible();
  expect(await unnamed(page, "[data-voice-invitation]")).toEqual([]);
  await fits(page, "[data-voice-invitation]", "invitation at 320px");
  await page.screenshot({ path: join(shots, "invitation-320.png"), fullPage: true });
  // The link opens Voice from the keyboard.
  await card.getByRole("link", { name: /voice session/i }).focus();
  await viaKeyboard(page);
  expect(await showsFocus(page)).toBe(true);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { level: 1, name: "Voice" })).toBeVisible();
  await page.goto(`${origin}/admin/#/overview`);
  await expect(card).toBeVisible();
  // Dismiss is a real button reached by Tab, and activated with Space.
  await card.getByRole("link", { name: /voice session/i }).focus();
  await tabTo(page, '[aria-label="Dismiss this invitation"]', 6);
  await page.keyboard.press("Space");
  await expect(card).toHaveCount(0);
});

test("the session works from the keyboard alone, with names a screen reader can use", async ({ page }) => {
  await signIn(page, "#/voice");
  await expect(page.getByRole("heading", { level: 1, name: "Voice" })).toBeVisible();
  await expect(cards(page)).toHaveCount(3);
  const heading = page.getByRole("heading", { name: "Choose what to write about" });
  await expect(heading).toBeVisible();
  // The choices are one radio group with a legend, and each card has a name.
  expect(await unnamed(page, "ob-voice-session")).toEqual([]);
  await expect(page.getByRole("radio")).toHaveCount(5);
  await expect(page.getByRole("group", { name: "Where it is kept" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Start the 3:00 timer" })).toBeDisabled();

  // Tab into the prompt group, choose with Space, and start with Enter.
  await heading.focus();
  await tabTo(page, "[data-prompt] input");
  expect(await showsFocus(page)).toBe(true);
  await page.keyboard.press("Space");
  await expect(page.getByRole("button", { name: "Start the 3:00 timer" })).toBeEnabled();
  await tabTo(page, '[data-action="voice-start"]');
  expect(await showsFocus(page)).toBe(true);
  await page.keyboard.press("Enter");

  // Focus lands in the rough box, which has a name and a description, and the clock is a named timer.
  const rough = page.locator("[data-voice-rough]");
  await expect(rough).toBeFocused();
  await expect(page.getByRole("textbox", { name: /./ })).toBeVisible();
  expect((await rough.getAttribute("aria-describedby")).split(" ").length).toBe(2);
  expect(await unnamed(page, "ob-voice-session")).toEqual([]);
  await expect(page.getByRole("timer", { name: "Time remaining" })).toBeVisible();
  await page.keyboard.type("typed from the keyboard, teh way it comes");
  await expect(page.locator("[data-voice-count]")).toContainText("words");

  // Tab reaches the buttons in reading order; Enter locks.
  await tabTo(page, '[data-action="voice-finish"]', 6);
  expect(await showsFocus(page)).toBe(true);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Your rough draft is locked" })).toBeVisible();
  await expect(page.locator("[data-voice-polished-body]")).toBeFocused();
  // The locked rough text is plain text, not a control.
  expect(await page.locator("[data-voice-rough-view]").locator("input, textarea, [contenteditable]").count()).toBe(0);
  expect(await unnamed(page, "ob-voice-session")).toEqual([]);
  // Edit and save the polished copy from the keyboard, then hear that it was saved.
  await page.keyboard.press("Control+A");
  await page.keyboard.type("Typed from the keyboard, the way it comes.");
  await tabTo(page, "button", 8);
  await expect(page.getByRole("button", { name: "Save polished draft" })).toBeVisible();
  await page.getByRole("button", { name: "Save polished draft" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("[data-voice-polished-status]")).toContainText("Saved.");
  expect(await page.locator("[data-voice-polished-status]").getAttribute("role")).toBe("status");
});

test("the clock is not a live region and the view speaks only a few times", async ({ page }) => {
  await signIn(page, "#/overview");
  const drawn = await api(page, "POST", "voice/draw", {});
  const started = await api(page, "POST", "voice/session/start", { promptId: drawn.body.prompts[1].id });
  expect(started.status).toBe(201);
  await page.goto(`${origin}/admin/#/voice`);
  await expect(page.locator("[data-voice-rough]")).toBeVisible();
  // Record everything the live region is given while the clock ticks.
  await page.evaluate(() => {
    window.__said = [];
    const live = document.querySelector("[data-voice-announce]");
    new MutationObserver(() => { if (live.textContent) window.__said.push(live.textContent); }).observe(live, { childList: true, characterData: true, subtree: true });
  });
  const clock = page.locator("[data-voice-clock]");
  const first = await clock.innerText();
  await expect.poll(() => clock.innerText(), { timeout: 8000 }).not.toBe(first);
  const live = await page.evaluate(() => {
    const timer = document.querySelector("[data-voice-timer]");
    const chain = [];
    for (let node = document.querySelector("[data-voice-clock]"); node && node !== document.body; node = node.parentElement) {
      chain.push(node.getAttribute("aria-live") || "");
    }
    return { clockChain: chain, role: document.querySelector("[data-voice-clock]").getAttribute("role"), timerLive: timer.getAttribute("aria-live"), announcers: document.querySelectorAll("[data-voice-announce]").length, politeness: document.querySelector("[data-voice-announce]").getAttribute("aria-live") };
  });
  expect(live.role).toBe("timer");
  expect(live.clockChain.filter((value) => value === "polite" || value === "assertive")).toEqual([]);
  expect(live.announcers).toBe(1);
  expect(live.politeness).toBe("polite");
  // A full three minutes starts silent: nothing was said by ticking.
  expect(await page.evaluate(() => window.__said)).toEqual([]);
  await scrapOpen(page);
});

test("a short window is announced at its marks, not every second, and a warning is also written", async ({ page }) => {
  test.setTimeout(60000);
  await signIn(page, "#/overview");
  const drawn = await api(page, "POST", "voice/draw", {});
  const started = await api(page, "POST", "voice/session/start", { promptId: drawn.body.prompts[0].id, timeLimitSeconds: 65 });
  expect(started.status).toBe(201);
  await page.goto(`${origin}/admin/#/voice`);
  await expect(page.locator("[data-voice-rough]")).toBeVisible();
  await page.evaluate(() => {
    window.__said = [];
    const live = document.querySelector("[data-voice-announce]");
    new MutationObserver(() => { if (live.textContent) window.__said.push(live.textContent); }).observe(live, { childList: true, characterData: true, subtree: true });
  });
  await page.waitForTimeout(9000);
  const said = await page.evaluate(() => window.__said);
  expect(said.length, JSON.stringify(said)).toBeLessThanOrEqual(2);
  for (const line of said) expect(line).toMatch(/minute|second/i);
  await expect(page.locator("[data-voice-timer]")).toHaveAttribute("data-state", /warning|running/);
  await scrapOpen(page);
});

/** Write and lock two samples (one portable) and polish one, so the library and the guide have something to show. */
async function seed(page) {
  await signIn(page, "#/overview");
  await scrapOpen(page);
  const drawn = await api(page, "POST", "voice/draw", {});
  const made = [];
  for (const [index, visibility] of [[0, "private"], [1, "portable"]]) {
    const started = await api(page, "POST", "voice/session/start", { promptId: drawn.body.prompts[index].id, visibility });
    expect(started.status).toBe(201);
    const locked = await api(page, "POST", "voice/session/lock", { sessionId: started.body.sessionId, text: `so i delted the foldr ${LONG} and panicked` });
    expect(locked.status).toBe(200);
    made.push(locked.body.sample);
  }
  const polished = await api(page, "POST", "voice/samples", { roughOf: made[0].file, title: `A polished title ${LONG}`, body: "I deleted the wrong folder." });
  expect(polished.status).toBe(201);
  mkdirSync(join(root, "assistant", "context"), { recursive: true });
  writeFileSync(join(root, "assistant", "context", "voice.md"), "# Voice guide\n\n## Habits and quirks\n\n- Likes lists\n");
}

test("the library is operable by keyboard, every control is named, and it fits 320px", async ({ page }) => {
  await seed(page);
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto(`${origin}/admin/#/voice/library`);
  await expect(page.getByRole("heading", { level: 2, name: "Your voice samples" })).toBeVisible();
  await expect(page.locator("li.oba-voice-row[data-prompt]").first()).toBeVisible();
  expect(await unnamed(page, "ob-voice-library")).toEqual([]);
  // The groups are headings and each list is named for its pack; the links say which sample they open.
  expect(await page.locator("ob-voice-library h3").count()).toBeGreaterThan(1);
  const links = await page.locator("ob-voice-library a[data-action^='voice-']").evaluateAll((nodes) => nodes.map((n) => n.getAttribute("aria-label") || n.textContent.trim()));
  expect(new Set(links).size, "links to different samples have different names").toBe(links.length);
  await fits(page, "ob-voice-library", "library at 320px");
  await page.screenshot({ path: join(shots, "library-320.png"), fullPage: true });

  // Open the rough draft with Enter, from the keyboard; it is read-only and the heading takes focus.
  const row = page.locator('li.oba-voice-row:has([data-stage="polished"])').first();
  await row.getByRole("link", { name: /^Read the rough draft/ }).focus();
  await viaKeyboard(page);
  expect(await showsFocus(page)).toBe(true);
  await page.keyboard.press("Enter");
  await expect(page.locator("[data-voice-rough-view]")).toBeVisible();
  expect(await page.locator("[data-voice-rough-view]").locator("input, textarea, [contenteditable]").count()).toBe(0);
  await expect(page.locator("[data-voice-heading]")).toBeFocused();
  expect(await unnamed(page, "ob-voice-library")).toEqual([]);
  await fits(page, "ob-voice-library", "an open sample at 320px");
  await page.screenshot({ path: join(shots, "open-320.png"), fullPage: true });
});

test("the guide and the sample choices are named, keyboard operable and fit 320px", async ({ page }) => {
  // Show every pane, the Assistant included (the default preset keeps it under a menu).
  const preferences = join(root, ".openblog", "private", "admin-preferences", `${createHash("sha256").update("writer").digest("hex")}.json`);
  mkdirSync(dirname(preferences), { recursive: true });
  writeFileSync(preferences, JSON.stringify({ schemaVersion: 1, preset: "advanced", density: "comfortable", editorMode: "markdown", moduleOrder: MODULES, hiddenModules: [], voiceInvitationDismissed: true }));
  await signIn(page, "#/overview");
  let proposed = 0;
  await page.route("**/admin/api/assistant/status", (route) =>
    route.fulfill({ json: { providerType: "generic-https", model: "test", destination: "https://assistant.example", configured: true, capabilities: { review: true }, message: "ready" } }),
  );
  const file = voiceFiles().map((f) => f.split(/[\\/]/).pop()).find((name) => name.endsWith("-rough.md"));
  await page.route("**/admin/api/assistant/voice-guide", (route) => {
    proposed += 1;
    return route.fulfill({
      json: {
        guide: { sections: [], unknown: [] },
        markdown: `# Voice guide\n\n## Word choice\n\n- Starts with so: "so i delted" (${file}) ${LONG}\n`,
        current: { visibility: "portable", exists: true, content: "# Voice guide\n\n## Habits and quirks\n\n- Likes lists\n" },
        diff: `--- voice.md (saved)\n+++ voice.md (proposed)\n@@ -1,5 +1,5 @@\n # Voice guide\n-## Habits and quirks\n+## Word choice ${LONG}\n`,
        targets: { portable: { exists: true, valid: true, etag: null, characters: 40 }, private: { exists: false, valid: true, etag: null, characters: 0 } },
      },
    });
  });
  await page.goto(`${origin}/admin/#/edit/posts%2Fvoice-demo.md`);
  await expect(page.getByRole("textbox", { name: "Title", exact: true })).toHaveValue("Voice demo");
  await page.locator('[data-pane-target="assistant"]').click();
  await page.getByRole("navigation", { name: "Assistant views" }).getByRole("button", { name: "Context", exact: true }).click();
  // The tools are opened on a wide screen (the view switcher is a menu there), then the window narrows.
  await page.setViewportSize({ width: 320, height: 640 });
  const section = '[aria-labelledby="oba-voice-samples-title"]';
  await expect(page.getByRole("heading", { level: 4, name: "Voice samples" })).toBeVisible();
  const card = page.locator("[data-voice-sample]").first();
  await expect(card).toBeVisible();
  expect(await unnamed(page, section)).toEqual([]);
  // A sample is a checkbox with a name, chosen with Space; the disclosure is a polite region.
  const box = card.getByRole("checkbox");
  await box.focus();
  await viaKeyboard(page);
  expect(await showsFocus(page)).toBe(true);
  await page.keyboard.press("Space");
  await expect(box).toBeChecked();
  expect(await page.locator(".oba-assistant-disclosure-panel", { hasText: "Context disclosure" }).locator("[aria-live]").first().getAttribute("aria-live")).toBe("polite");
  await page.getByRole("button", { name: "Propose a voice guide from selected samples" }).focus();
  await page.keyboard.press("Enter");
  const result = page.getByRole("region", { name: "Proposed voice guide" });
  await expect(result).toBeVisible();
  expect(proposed).toBe(1);
  // Added and removed lines are told apart in words, not only by colour.
  const marks = await result.locator("[data-diff]").evaluateAll((nodes) => nodes.map((n) => n.textContent.trim().charAt(0)));
  expect(marks.some((m) => m === "+") && marks.some((m) => m === "-")).toBe(true);
  expect(await unnamed(page, section)).toEqual([]);
  await expect(result.getByRole("textbox", { name: /Proposed voice guide Markdown/ })).toBeVisible();
  await expect(result.getByRole("button", { name: "Save as private" })).toBeVisible();
  await fits(page, section, "guide at 320px");
  await page.screenshot({ path: join(shots, "guide-320.png"), fullPage: true });
  // Discard by keyboard leaves the saved guide untouched.
  await result.getByRole("button", { name: "Discard" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText("Proposal discarded. Nothing was saved.")).toBeVisible();
});

test("at 320px and at 400% zoom every voice view stays inside the screen", async ({ page }) => {
  // 400% zoom on a 1280px screen is a 320 CSS pixel window about 256px tall: the same layout rules, less height.
  for (const [label, size] of [["320", { width: 320, height: 640 }], ["zoom400", { width: 320, height: 256 }]]) {
    await page.setViewportSize(size);
    await signIn(page, "#/voice");
    await expect(cards(page)).toHaveCount(3);
    await fits(page, "ob-voice-session", `draw at ${label}`);
    // Every card is below the one before it and inside the gutters.
    const boxes = await cards(page).evaluateAll((nodes) => nodes.map((n) => n.getBoundingClientRect()).map((b) => ({ left: b.left, right: b.right, top: b.top, bottom: b.bottom })));
    for (let i = 1; i < boxes.length; i += 1) expect(boxes[i].top).toBeGreaterThanOrEqual(boxes[i - 1].bottom - TOLERANCE);
    for (const b of boxes) {
      expect(b.left).toBeGreaterThanOrEqual(-TOLERANCE);
      expect(b.right).toBeLessThanOrEqual(size.width + TOLERANCE);
    }
    await page.screenshot({ path: join(shots, `draw-${label}.png`), fullPage: true });

    await cards(page).first().locator("input").check();
    await page.getByRole("button", { name: "Start the 3:00 timer" }).click();
    const rough = page.locator("[data-voice-rough]");
    await expect(rough).toBeVisible();
    await rough.fill(`${LONG} ${LONG}`);
    await fits(page, "ob-voice-session", `write at ${label}`);
    // The controls stay reachable: scroll to the end and the bar is in view, not hidden behind the box.
    await page.getByRole("button", { name: "Finish early" }).scrollIntoViewIfNeeded();
    await expect(page.getByRole("button", { name: "Finish early" })).toBeInViewport();
    await expect(page.locator("[data-voice-clock]")).toBeVisible();
    await page.screenshot({ path: join(shots, `write-${label}.png`), fullPage: true });
    await page.getByRole("button", { name: "Finish early" }).click();
    await expect(page.locator("[data-voice-rough-text]")).toBeVisible();
    await fits(page, "ob-voice-session", `polish at ${label}`);
    await page.getByRole("button", { name: "Save polished draft" }).scrollIntoViewIfNeeded();
    await expect(page.getByRole("button", { name: "Save polished draft" })).toBeInViewport();
    await page.screenshot({ path: join(shots, `polish-${label}.png`), fullPage: true });

    await page.goto(`${origin}/admin/#/voice/library`);
    await expect(page.getByRole("heading", { level: 2, name: "Your voice samples" })).toBeVisible();
    await fits(page, "ob-voice-library", `library at ${label}`);
    await page.locator("[data-voice-erase]").getByRole("button", { name: "Erase all voice data…" }).click();
    await expect(page.locator("[data-voice-erase-list]")).toBeVisible();
    await fits(page, "ob-voice-library", `erase at ${label}`);
    await page.screenshot({ path: join(shots, `erase-${label}.png`), fullPage: true });
    await page.getByRole("button", { name: "Keep my data" }).click();

    await page.goto(`${origin}/admin/#/overview`);
    await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
  }
});

test("reduced motion stops the warning pulse and every voice transition", async ({ page }) => {
  await signIn(page, "#/overview");
  await scrapOpen(page);
  const drawn = await api(page, "POST", "voice/draw", {});
  // A 30 second window is in its warning state from the first frame.
  const started = await api(page, "POST", "voice/session/start", { promptId: drawn.body.prompts[0].id, timeLimitSeconds: 30 });
  expect(started.status).toBe(201);
  const motion = (page) =>
    page.evaluate(() => {
      const names = [...document.querySelectorAll(".oba-voice, .oba-voice *")].map((node) => getComputedStyle(node)).map((style) => ({ animation: style.animationName, transition: style.transitionDuration, behavior: style.scrollBehavior }));
      return {
        timer: getComputedStyle(document.querySelector("[data-voice-timer]")).animationName,
        running: names.filter((n) => n.animation !== "none").length,
        transitions: names.filter((n) => n.transition.split(",").some((d) => parseFloat(d) > 0)).length,
        smooth: names.filter((n) => n.behavior === "smooth").length,
      };
    });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto(`${origin}/admin/#/voice`);
  await expect(page.locator("[data-voice-timer]")).toHaveAttribute("data-state", "warning");
  // The pulse exists for people who have not asked for less motion, so the test is not vacuous.
  expect((await motion(page)).timer).not.toBe("none");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect.poll(async () => (await motion(page)).timer).toBe("none");
  const reduced = await motion(page);
  expect(reduced.running).toBe(0);
  expect(reduced.transitions).toBe(0);
  expect(reduced.smooth).toBe(0);
  // The warning is still written in words, not only moved.
  await expect(page.locator("[data-voice-timer-state]")).toContainText("seconds left");
  // The library obeys the same rule.
  await scrapOpen(page);
  await page.goto(`${origin}/admin/#/voice/library`);
  await expect(page.getByRole("heading", { level: 2, name: "Your voice samples" })).toBeVisible();
  const library = await page.evaluate(() => [...document.querySelectorAll("ob-voice-library, ob-voice-library *")].filter((node) => {
    const style = getComputedStyle(node);
    return style.animationName !== "none" || style.transitionDuration.split(",").some((d) => parseFloat(d) > 0);
  }).map((node) => `${node.tagName.toLowerCase()}.${node.className}`));
  expect(library).toEqual([]);
});

test("erasing is reachable and finishable from the keyboard, announces its result and leaves nothing", async ({ page }) => {
  expect(voiceFiles().length).toBeGreaterThan(0);
  await signIn(page, "#/voice/library");
  await expect(page.getByRole("heading", { level: 2, name: "Your voice samples" })).toBeVisible();
  const open = page.locator("[data-voice-erase]").getByRole("button", { name: "Erase all voice data…" });
  await open.focus();
  await viaKeyboard(page);
  expect(await showsFocus(page)).toBe(true);
  await page.keyboard.press("Enter");
  const list = page.locator("[data-voice-erase-list]");
  await expect(list).toBeVisible();
  // The list is a list, and the word box has a visible name; Erase stays off until the word is typed.
  // Every sample and the guide are listed, each as an item.
  expect(await list.locator("li").count()).toBe(voiceFiles().length + 1);
  await expect(list).toContainText("voice.md");
  const confirm = page.getByRole("button", { name: "Erase everything" });
  await expect(confirm).toBeDisabled();
  const word = page.getByLabel(/^Type "erase" to confirm/);
  await expect(word).toBeVisible();
  expect(await unnamed(page, "[data-voice-erase]")).toEqual([]);
  await word.focus();
  await page.keyboard.type("eras");
  await expect(confirm).toBeDisabled();
  await page.keyboard.type("e");
  await expect(confirm).toBeEnabled();
  await tabTo(page, "button", 3);
  await page.keyboard.press("Enter");
  const status = page.locator("[data-voice-erase-status]");
  await expect(status).toContainText("nothing is left");
  expect(await status.getAttribute("role")).toBe("status");
  expect(await status.getAttribute("aria-live")).toBe("polite");
  expect(voiceFiles()).toEqual([]);
  expect(existsSync(join(root, ".openblog", "private", "voice", "session.json"))).toBe(false);
});
