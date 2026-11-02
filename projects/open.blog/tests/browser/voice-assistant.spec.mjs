import { test, expect } from "@playwright/test";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { removeTree } from "./teardown.mjs";

// Voice samples and the voice guide as Assistant context (epic #409, ADRs 0278 to 0281), in the
// real Admin: samples written by the real CLI are listed in the Context view with stage, pack,
// visibility and size; selecting them discloses them with a running total; a proposed guide is
// shown as changes against the saved guide and nothing is written until Save; Discard writes
// nothing. The provider is mocked at the browser, so no network is used.

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const binary = join(repository, "target", "debug", process.platform === "win32" ? "openblog.exe" : "openblog");
const password = randomBytes(24).toString("hex");
const MODULES = ["social", "release", "field", "optimize", "accessibility", "evidence", "research", "assistant", "analytics", "contributors", "public-site"];
const SAVED = "# Voice guide\n\n## Habits and quirks\n\n- Likes lists\n";
const PROPOSED = "# Voice guide\n\n## Word choice\n\n- Starts with so: \"so i delted\" (SAMPLE) (one sample)\n\n## What is not yet known\n\n- How you end a piece\n";
let root;
let server;
let origin;

const privateDir = () => join(root, ".openblog", "private", "context", "voice");
const guidePath = () => join(root, "assistant", "context", "voice.md");

test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "openblog-voice-assistant-"));
  cpSync(join(repository, "examples", "portable-publishing"), root, { recursive: true });
  writeFileSync(join(root, "content", "posts", "voice-demo.md"), "---\ntitle: Voice demo\ndate: 2026-10-01\n---\n\nSome body text for the demo.\n");
  execFileSync(binary, ["user", "add", "writer", "--root", root], { env: { ...process.env, OPENBLOG_PASSWORD: password }, stdio: "pipe" });
  for (const [prompt, text] of [["a-mistake-i-made", "so i delted the foldr\nand panicked\n.\n"], ["a-day-in-the-life", "woke up late\nmade tea\n.\n"]]) {
    execFileSync(binary, ["voice", prompt, "--stdin", "--root", root], { input: text, stdio: "pipe" });
  }
  // Show every pane, the Assistant included.
  const preferences = join(root, ".openblog", "private", "admin-preferences", `${createHash("sha256").update("writer").digest("hex")}.json`);
  mkdirSync(dirname(preferences), { recursive: true });
  writeFileSync(preferences, JSON.stringify({ schemaVersion: 1, preset: "advanced", density: "comfortable", editorMode: "markdown", moduleOrder: MODULES, hiddenModules: [] }));
  mkdirSync(dirname(guidePath()), { recursive: true });
  writeFileSync(guidePath(), SAVED);
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

async function openContext(page) {
  await page.goto(`${origin}/admin/`);
  const username = page.getByLabel("Username", { exact: true });
  if (await username.waitFor({ state: "visible", timeout: 5000 }).then(() => true, () => false)) {
    await username.fill("writer");
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.locator('[data-action="logout"]')).toBeVisible();
  }
  await page.goto(`${origin}/admin/#/edit/posts%2Fvoice-demo.md`);
  await expect(page.getByRole("textbox", { name: "Title", exact: true })).toHaveValue("Voice demo");
  await page.locator('[data-pane-target="assistant"]').click();
  await page.getByRole("navigation", { name: "Assistant views" }).getByRole("button", { name: "Context", exact: true }).click();
  await expect(page.getByRole("heading", { level: 4, name: "Voice samples" })).toBeVisible();
}

test("voice samples are chosen as context and a proposed guide is saved only on approval", async ({ page }) => {
  const samples = readdirSync(privateDir());
  expect(samples).toHaveLength(2);
  const mistake = samples.find((name) => name.includes("a-mistake-i-made"));
  const proposal = {
    guide: { sections: [], unknown: [] },
    markdown: PROPOSED.replace("SAMPLE", mistake),
    current: { visibility: "portable", exists: true, content: SAVED },
    diff: "--- voice.md (saved)\n+++ voice.md (proposed)\n@@ -1,5 +1,8 @@\n # Voice guide\n \n-## Habits and quirks\n+## Word choice\n",
    targets: { portable: { exists: true, valid: true, etag: null, characters: SAVED.length }, private: { exists: false, valid: true, etag: null, characters: 0 } },
  };
  let proposalRequest = null;
  await page.route("**/admin/api/assistant/status", (route) =>
    route.fulfill({ json: { providerType: "generic-https", model: "test", destination: "https://assistant.example", configured: true, capabilities: { review: true }, message: "ready" } }),
  );
  await page.route("**/admin/api/assistant/voice-guide", (route) => {
    proposalRequest = route.request().postDataJSON();
    return route.fulfill({ json: proposal });
  });
  await openContext(page);

  // Listed with stage, pack, visibility and size; nothing is selected until chosen.
  const card = page.locator(`[data-voice-sample="${mistake}"]`);
  await expect(card).toContainText("Rough draft");
  await expect(card).toContainText("pack stories");
  await expect(card).toContainText("Private");
  await expect(card).toContainText("characters");
  await expect(page.getByText("No context selected.")).toBeVisible();

  // Choosing it discloses it, with the running total against the request budget.
  await card.getByRole("checkbox").check();
  const disclosure = page.locator(".oba-assistant-disclosure-panel", { hasText: "Context disclosure" });
  await expect(disclosure).toContainText("Voice sample · rough · stories · Private");
  await expect(disclosure).toContainText("1 of 8 voice samples");

  // Propose: shown as changes; nothing is written.
  await page.getByRole("button", { name: "Propose a voice guide from selected samples" }).click();
  const result = page.getByRole("region", { name: "Proposed voice guide" });
  await expect(result.locator("[data-diff='add']").first()).toBeVisible();
  expect(proposalRequest).toEqual({ sampleIds: [`voice:private:${mistake}`] });
  await expect(result.locator("[data-diff='remove']").first()).toContainText("-## Habits and quirks");
  expect(readFileSync(guidePath(), "utf8")).toBe(SAVED);

  // Discard leaves the files as they were.
  await result.getByRole("button", { name: "Discard" }).click();
  await expect(page.getByText("Proposal discarded. Nothing was saved.")).toBeVisible();
  expect(readFileSync(guidePath(), "utf8")).toBe(SAVED);
  expect(existsSync(join(root, ".openblog", "private", "context", "voice.md"))).toBe(false);

  // Propose again, edit, and Save as private: the explicit destination is the only write.
  await page.getByRole("button", { name: "Propose a voice guide from selected samples" }).click();
  const editor = result.getByRole("textbox", { name: /Proposed voice guide Markdown/ });
  await editor.fill(`${proposal.markdown}\n- My own line\n`);
  await result.getByRole("button", { name: "Save as private" }).click();
  await expect(page.getByText("Voice guide saved as private.")).toBeVisible();
  expect(readFileSync(join(root, ".openblog", "private", "context", "voice.md"), "utf8")).toBe(`${proposal.markdown}\n- My own line\n`);
  expect(readFileSync(guidePath(), "utf8")).toBe(SAVED);
  // The rough sample is exactly as written.
  expect(readFileSync(join(privateDir(), mistake), "utf8")).toContain("so i delted the foldr\nand panicked");

  // The saved guide is now listed as context and can be selected like any other.
  await expect(page.getByRole("heading", { level: 4, name: /Voice guide · Private/ })).toBeVisible();
});

test("an over-budget voice selection is refused before any request", async ({ page }) => {
  const posts = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().includes("/admin/api/assistant/")) posts.push(request.url());
  });
  await page.route("**/admin/api/assistant/status", (route) =>
    route.fulfill({ json: { providerType: "generic-https", model: "test", destination: "https://assistant.example", configured: true, capabilities: { review: true }, message: "ready" } }),
  );
  // The server's budget, lowered so that two small samples exceed it.
  await page.route("**/admin/api/assistant/context?**", async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    json.voiceBudget = { samples: 1, characters: 120000 };
    await route.fulfill({ response, json });
  });
  await openContext(page);
  const cards = page.locator("[data-voice-sample]");
  await expect(cards).toHaveCount(2);
  await cards.nth(0).getByRole("checkbox").check();
  await cards.nth(1).getByRole("checkbox").check();
  const disclosure = page.locator(".oba-assistant-disclosure-panel", { hasText: "Context disclosure" });
  await expect(disclosure).toContainText("2 voice samples are selected; one request carries at most 1.");
  await page.getByRole("navigation", { name: "Assistant views" }).getByRole("button", { name: "Review", exact: true }).click();
  await page.getByRole("group", { name: "Review skills" }).getByRole("checkbox").first().check();
  await page.getByRole("button", { name: "Run document review" }).click();
  await expect(page.getByText(/Document review did not run. 2 voice samples are selected/)).toBeVisible();
  expect(posts).toEqual([]);
});

test("a proposal folded into the saved guide keeps what it does not address and waits for a choice on each change", async ({ page }) => {
  const saved = readFileSync(guidePath(), "utf8");
  const changeLine = { change: 0, current: "- Says plainly: \"plain words\" (2026-01-01-gone-rough.md) (one sample)", proposed: "- Says plainly, all lower case: \"so i delted\" (2026-10-28-a-mistake-i-made-rough.md) (one sample)" };
  const lines = ["# Voice guide", "", "My own note at the top.", "", "## Word choice", "", changeLine, "- Likes lists: \"a list\" (2026-01-02-lists-rough.md)", "", "## What is not yet known", "", "- Endings"];
  const proposal = {
    guide: { sections: [], unknown: [] },
    markdown: null,
    portableAllowed: true,
    current: { visibility: "portable", exists: true, content: saved },
    diff: "--- voice.md (saved)\n+++ voice.md (proposed)\n@@ -1,1 +1,1 @@\n-x\n+y\n",
    targets: { portable: { exists: true, valid: true, etag: null, characters: saved.length }, private: { exists: false, valid: true, etag: null, characters: 0 } },
    merge: {
      changes: 1,
      freeText: true,
      ownSections: [],
      sections: [{ id: "diction", heading: "Word choice", traits: [
        { status: "changed", change: 0, check: "sample-missing", current: { statement: "Says plainly", quote: "plain words", sample: "2026-01-01-gone-rough.md", oneSample: true }, proposed: { statement: "Says plainly, all lower case", quote: "so i delted", sample: "2026-10-28-a-mistake-i-made-rough.md", oneSample: true } },
        { status: "kept", check: "verified", current: { statement: "Likes lists", quote: "a list", sample: "2026-01-02-lists-rough.md", oneSample: false } },
      ] }],
      unknown: [{ text: "Endings", status: "kept" }],
      lines,
    },
  };
  await page.route("**/admin/api/assistant/status", (route) =>
    route.fulfill({ json: { providerType: "generic-https", model: "test", destination: "https://assistant.example", configured: true, capabilities: { review: true }, message: "ready" } }),
  );
  await page.route("**/admin/api/assistant/voice-guide", (route) => route.fulfill({ json: proposal }));
  await page.setViewportSize({ width: 360, height: 800 });
  await openContext(page);
  const samples = readdirSync(privateDir());
  const mistake = samples.find((name) => name.includes("a-mistake-i-made"));
  await page.locator(`[data-voice-sample="${mistake}"]`).getByRole("checkbox").check();
  await page.getByRole("button", { name: "Propose a voice guide from selected samples" }).click();
  const result = page.getByRole("region", { name: "Proposed voice guide" });
  const merged = result.getByRole("region", { name: /Your guide, trait by trait/ });
  await expect(merged).toBeVisible();
  await expect(merged.locator("[data-merge='kept']").first()).toContainText("Kept from your current guide");
  await expect(merged.getByText("Your own text outside the traits is kept where it is.")).toBeVisible();
  const change = merged.getByRole("group", { name: /Says plainly/ });
  await expect(change).toContainText("Keep current");
  await expect(change).toContainText("Take proposed");
  await expect(change.locator("[data-check='sample-missing']")).toBeVisible();

  // Nothing can be saved until the change is decided.
  const savePrivate = result.getByRole("button", { name: "Save as private" });
  await expect(savePrivate).toBeDisabled();
  await expect(result.locator("[data-voice-guide-pending]")).toContainText("1 changed trait");

  // Keeping the current text joins the server's lines with the old trait, from the keyboard.
  await change.getByRole("radio", { name: /Keep current/ }).focus();
  await page.keyboard.press("Space");
  await expect(savePrivate).toBeEnabled();
  const editor = result.getByRole("textbox", { name: /Proposed voice guide Markdown/ });
  await expect(editor).toHaveValue(`${lines.map((line) => (typeof line === "string" ? line : line.current)).join("\n")}\n`);
  await change.getByRole("radio", { name: /Take proposed/ }).check();
  await expect(editor).toHaveValue(/Says plainly, all lower case/);

  // The merged view fits a phone without sideways scrolling.
  const overflow = await merged.evaluate((element) => element.scrollWidth - element.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);

  await result.getByRole("button", { name: "Discard" }).click();
  await expect(page.getByText("Proposal discarded. Nothing was saved.")).toBeVisible();
  expect(readFileSync(guidePath(), "utf8")).toBe(saved);
});

test("the voice guide moves between portable and private from beside it, previewed and reversible", async ({ page }) => {
  const privateGuide = join(root, ".openblog", "private", "context", "voice.md");
  rmSync(privateGuide, { force: true });
  writeFileSync(guidePath(), SAVED);
  await openContext(page);
  const portableCard = page.getByRole("region", { name: "Voice guide · Portable" });
  await portableCard.getByRole("button", { name: "Make private" }).click();
  await expect(portableCard.locator("[data-voice-guide-move-status]")).toContainText("from assistant/context/voice.md to .openblog/private/context/voice.md");
  // Cancel moves nothing and gives focus back.
  await portableCard.getByRole("button", { name: "Cancel" }).click();
  await expect(portableCard.locator("[data-voice-guide-move-status]")).toHaveText("Nothing was moved.");
  await expect(portableCard.getByRole("button", { name: "Make private" })).toBeFocused();
  expect(existsSync(privateGuide)).toBe(false);

  await portableCard.getByRole("button", { name: "Make private" }).click();
  await portableCard.getByRole("button", { name: "Move to private" }).click();
  await expect(page.getByText("The voice guide is now private. You can move it back the same way.")).toBeVisible();
  expect(existsSync(guidePath())).toBe(false);
  expect(readFileSync(privateGuide, "utf8")).toBe(SAVED);

  const privateCard = page.getByRole("region", { name: "Voice guide · Private" });
  await privateCard.getByRole("button", { name: "Make portable" }).click();
  await privateCard.getByRole("button", { name: "Move to portable" }).click();
  await expect(page.getByText("The voice guide is now portable. You can move it back the same way.")).toBeVisible();
  expect(readFileSync(guidePath(), "utf8")).toBe(SAVED);
  expect(existsSync(privateGuide)).toBe(false);

  // A private guide that quotes private samples is refused before anything moves.
  rmSync(guidePath());
  const quoting = "# Voice guide\n<!-- openblog:voice-provenance sources=private -->\n";
  writeFileSync(privateGuide, quoting);
  await page.reload();
  await openContext(page);
  const quotingCard = page.getByRole("region", { name: "Voice guide · Private" });
  await quotingCard.getByRole("button", { name: "Make portable" }).click();
  await expect(quotingCard.locator("[data-voice-guide-move-status]")).toContainText("quotes private samples");
  await expect(quotingCard.getByRole("button", { name: "Move to portable" })).toHaveCount(0);
  expect(readFileSync(privateGuide, "utf8")).toBe(quoting);
  expect(existsSync(guidePath())).toBe(false);
  writeFileSync(guidePath(), SAVED);
  rmSync(privateGuide);
});

test("voice match reviews only the selected text and its suggestion applies and undoes", async ({ page }) => {
  let reviewRequest = null;
  await page.route("**/admin/api/assistant/status", (route) =>
    route.fulfill({ json: { providerType: "generic-https", model: "test", destination: "https://assistant.example", configured: true, capabilities: { review: true }, message: "ready" } }),
  );
  await page.route("**/admin/api/assistant/review", (route) => {
    reviewRequest = route.request().postDataJSON();
    const { start, end } = reviewRequest.passage;
    return route.fulfill({
      json: {
        reviewId: "r1",
        scope: { kind: "selection", start, end, unit: "unicode-code-points" },
        skills: [{ id: "voice-match", version: "1.1.0" }],
        findings: [{ id: "m1", skillId: "voice-match", skillVersion: "1.1.0", category: "voice", severity: "note", title: "Sounds stiff", explanation: "You write plainly.", range: { start, end }, evidence: "Some body text", suggestion: "Plain words", sources: [], verification: "unverified-advice" }],
      },
    });
  });
  await openContext(page);
  // The Markdown editor of the open post (the Assistant pane sits beside it).
  const body = page.locator("#oba-body");
  const markdown = await body.inputValue();
  const at = markdown.indexOf("Some body text");
  await page.getByRole("navigation", { name: "Assistant views" }).getByRole("button", { name: "Review", exact: true }).click();
  const skills = page.getByRole("group", { name: "Review skills" });
  const voiceMatch = skills.locator("label", { hasText: "Voice match" }).getByRole("checkbox");
  // Voice match is for a passage: not offered for the whole document.
  await expect(voiceMatch).toBeDisabled();
  await page.getByRole("radio", { name: "Selected text" }).check();
  await expect(voiceMatch).toBeEnabled();
  await voiceMatch.check();
  await expect(page.locator(".oba-assistant-disclosure-panel", { hasText: "Review disclosure" })).toContainText("Selected text");

  // Without a selection nothing is sent.
  await body.evaluate((element) => element.setSelectionRange(0, 0));
  await page.getByRole("button", { name: "Review selected text" }).click();
  await expect(page.getByText(/The review did not run. Select some text in the draft first./)).toBeVisible();
  expect(reviewRequest).toBeNull();

  await body.evaluate((element, [from, to]) => element.setSelectionRange(from, to), [at, at + "Some body text".length]);
  await page.getByRole("button", { name: "Review selected text" }).click();
  await expect(page.getByRole("button", { name: "Apply suggestion" })).toBeVisible();
  expect(reviewRequest.passage).toEqual({ kind: "selection", start: Array.from(markdown.slice(0, at)).length, end: Array.from(markdown.slice(0, at)).length + 14 });
  expect(reviewRequest.skillIds).toEqual(["voice-match"]);
  await page.getByRole("button", { name: "Apply suggestion" }).click();
  await expect(body).toHaveValue(markdown.replace("Some body text", "Plain words"));
  await page.getByRole("button", { name: "Undo applied suggestion" }).click();
  await expect(body).toHaveValue(markdown);
});
